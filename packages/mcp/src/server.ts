import { openStore, ReviewStore, type SqlDatabase } from "@maestro/core";
import { ProviderConfigStore } from "@maestro/llm";
import { PlaybookStore, safeParsePlaybook } from "@maestro/playbook";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * MCP server.
 *
 * Exposes Maestro to Claude Code so an engineer can ask "what did Maestro find on PR 412
 * and why" without leaving their editor, and can retune an agent's model or persona from
 * the same place. It reads the same store the daemon writes, so there is one source of
 * truth rather than a parallel view.
 */
export interface McpDeps {
  db: SqlDatabase;
}

function text(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

export function buildServer(deps: McpDeps): McpServer {
  const { db } = deps;
  const server = new McpServer({ name: "maestro", version: "0.1.0" });

  server.registerTool(
    "list_reviews",
    {
      title: "List reviews",
      description: "Recent Maestro reviews, newest first, with state and cost.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        state: z.string().optional(),
      },
    },
    async ({ limit, state }) => {
      const rows = state
        ? db
            .prepare(
              `SELECT r.id, repos.owner, repos.name AS repo, r.pr_number, r.title, r.state,
                      r.cost_cents, r.created_at
               FROM reviews r JOIN repos ON repos.id = r.repo_id
               WHERE r.state = ? ORDER BY r.created_at DESC LIMIT ?`,
            )
            .all(state, limit ?? 20)
        : db
            .prepare(
              `SELECT r.id, repos.owner, repos.name AS repo, r.pr_number, r.title, r.state,
                      r.cost_cents, r.created_at
               FROM reviews r JOIN repos ON repos.id = r.repo_id
               ORDER BY r.created_at DESC LIMIT ?`,
            )
            .all(limit ?? 20);
      return text(rows);
    },
  );

  server.registerTool(
    "get_review",
    {
      title: "Get review",
      description: "Full detail for one review: tasks, findings, per-agent cost and timing.",
      inputSchema: { reviewId: z.string() },
    },
    async ({ reviewId }) =>
      text({
        review: db.prepare("SELECT * FROM reviews WHERE id=?").get(reviewId),
        tasks: db
          .prepare(
            "SELECT node_id, kind, agent_id, state, error, cost_cents FROM tasks WHERE review_id=?",
          )
          .all(reviewId),
        findings: db
          .prepare(
            "SELECT agent_id, file, line_start, category, severity, confidence, title, status FROM findings WHERE review_id=?",
          )
          .all(reviewId),
        spend: db
          .prepare(
            `SELECT provider_id, model, COUNT(*) AS steps, SUM(cost_cents) AS cost_cents
             FROM llm_calls WHERE review_id=? GROUP BY provider_id, model`,
          )
          .all(reviewId),
      }),
  );

  server.registerTool(
    "explain_finding",
    {
      title: "Explain finding",
      description: "The full body and evidence for one finding, plus which agents raised it.",
      inputSchema: { findingId: z.string() },
    },
    async ({ findingId }) => {
      const row = db.prepare("SELECT * FROM findings WHERE id=?").get(findingId);
      return row ? text(row) : text(`no finding with id ${findingId}`);
    },
  );

  server.registerTool(
    "dismiss_finding",
    {
      title: "Dismiss finding",
      description:
        "Mark a finding as dismissed. This is the feedback signal Maestro measures its own precision against.",
      inputSchema: { findingId: z.string(), reason: z.string().optional() },
    },
    async ({ findingId, reason }) => {
      db.prepare(
        "UPDATE findings SET status='dismissed', suppressed_reason=COALESCE(?, suppressed_reason) WHERE id=?",
      ).run(reason ?? null, findingId);
      return text({ ok: true, findingId, reason });
    },
  );

  server.registerTool(
    "get_playbook",
    {
      title: "Get playbook",
      description: "The active playbook: graph, agents, personas, model bindings, env spec.",
      inputSchema: {},
    },
    async () => {
      const record = new PlaybookStore(db).getActive("default");
      return record
        ? text({ version: record.version, id: record.id, document: record.doc })
        : text("no active playbook");
    },
  );

  server.registerTool(
    "set_agent_model",
    {
      title: "Set agent model",
      description:
        "Repoint one agent at a different provider/model. Publishes a new playbook version; reviews already running keep the version they were pinned to.",
      inputSchema: {
        agentId: z.string(),
        providerId: z.string(),
        model: z.string(),
        maxSteps: z.number().int().min(1).max(200).optional(),
        costCapCents: z.number().positive().optional(),
      },
    },
    async ({ agentId, providerId, model, maxSteps, costCapCents }) => {
      const store = new PlaybookStore(db);
      const active = store.getActive("default");
      if (!active) return text("no active playbook");

      const doc = structuredClone(active.doc);
      const agent = doc.agents.find((a) => a.id === agentId);
      if (!agent)
        return text(`no agent '${agentId}'. Available: ${doc.agents.map((a) => a.id).join(", ")}`);

      agent.model.providerId = providerId;
      agent.model.model = model;
      if (maxSteps) agent.model.maxSteps = maxSteps;
      if (costCapCents) agent.model.costCapCents = costCapCents;

      const record = store.publish(doc, {
        notes: `set ${agentId} -> ${providerId}/${model} via MCP`,
      });
      return text({ ok: true, version: record.version, agentId, providerId, model });
    },
  );

  server.registerTool(
    "update_persona",
    {
      title: "Update agent persona",
      description:
        "Replace one agent's persona. Maestro's fixed preamble and output contract are always applied around it and cannot be edited.",
      inputSchema: { agentId: z.string(), persona: z.string().min(1) },
    },
    async ({ agentId, persona }) => {
      const store = new PlaybookStore(db);
      const active = store.getActive("default");
      if (!active) return text("no active playbook");

      const doc = structuredClone(active.doc);
      const agent = doc.agents.find((a) => a.id === agentId);
      if (!agent) return text(`no agent '${agentId}'`);

      const previous = agent.persona;
      agent.persona = persona;
      const record = store.publish(doc, { notes: `persona update for ${agentId} via MCP` });
      return text({ ok: true, version: record.version, agentId, previousLength: previous.length });
    },
  );

  server.registerTool(
    "validate_playbook",
    {
      title: "Validate playbook",
      description:
        "Check a playbook document against the schema and graph invariants without publishing it.",
      inputSchema: { document: z.unknown() },
    },
    async ({ document }) => {
      const result = safeParsePlaybook(document);
      return text(result.ok ? { ok: true } : { ok: false, issues: result.issues });
    },
  );

  server.registerTool(
    "list_providers",
    {
      title: "List providers",
      description: "Configured LLM providers and whether a credential is resolvable for each.",
      inputSchema: {},
    },
    async () => {
      const store = new ProviderConfigStore(db);
      const registry = await store.buildRegistry();
      return text(store.list().map((p) => ({ ...p, available: registry.has(p.id) })));
    },
  );

  server.registerTool(
    "review_stats",
    {
      title: "Review statistics",
      description: "Aggregate counts and spend, for spotting cost or failure trends.",
      inputSchema: {},
    },
    async () =>
      text({
        byState: db.prepare("SELECT state, COUNT(*) AS n FROM reviews GROUP BY state").all(),
        findingsByAgent: db
          .prepare("SELECT agent_id, status, COUNT(*) AS n FROM findings GROUP BY agent_id, status")
          .all(),
        spend: db
          .prepare(
            "SELECT provider_id, model, SUM(cost_cents) AS cost_cents, COUNT(*) AS calls FROM llm_calls GROUP BY provider_id, model",
          )
          .all(),
      }),
  );

  // Resources: the active playbook, readable as a document rather than a tool call.
  server.registerResource(
    "playbook",
    "maestro://playbook/active",
    {
      title: "Active playbook",
      description: "The pipeline Maestro is currently running",
      mimeType: "application/json",
    },
    async (uri) => {
      const record = new PlaybookStore(db).getActive("default");
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(record?.doc ?? {}, null, 2),
          },
        ],
      };
    },
  );

  return server;
}

export async function runStdioServer(dbPath?: string): Promise<void> {
  const db = await openStore(dbPath ? { path: dbPath } : {});
  // Touch the review store so a fresh install has its schema before the first tool call.
  new ReviewStore(db);
  const server = buildServer({ db });
  await server.connect(new StdioServerTransport());
}
