import { randomUUID } from "node:crypto";
import { severityAtLeast } from "@maestro/agents";
import {
  hasPendingReviewJob,
  JobQueue,
  maestroHome,
  openStore,
  ReviewStore,
  type SqlDatabase,
} from "@maestro/core";
import { compareVersions, type EvalScore, loadScores, scoresDir } from "@maestro/engine";
import { findingCountsByAgent, parsePullRequestRef } from "@maestro/integrations";
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
    async ({ reviewId }) => {
      // A review that does not exist is not a review with nothing in it. Returning
      // `{review: undefined, tasks: [], findings: [], spend: []}` reads to a caller as
      // "this ran and found nothing", which is a different and wrong statement — and the
      // caller here is a model, which will act on it. `explain_finding` beside this one
      // already says so; this did not.
      const review = db.prepare("SELECT * FROM reviews WHERE id=?").get(reviewId);
      if (!review) return text(`no review with id ${reviewId}`);
      return text({
        review,
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
      });
    },
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
      const done = db
        .prepare(
          "UPDATE findings SET status='dismissed', suppressed_reason=COALESCE(?, suppressed_reason) WHERE id=?",
        )
        .run(reason ?? null, findingId);
      // `ok: true` for a finding that does not exist told the caller the dismissal
      // landed when nothing was updated. This tool is the feedback signal precision is
      // measured from, so a silently dropped dismissal is not a cosmetic error: the
      // number it feeds is quietly wrong, and a person who typed the id slightly wrong
      // has no way to know.
      if (done.changes === 0) return text(`no finding with id ${findingId}`);
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
        // Same splitter the admin API uses. A raw GROUP BY on `agent_id` reports an
        // agent called `security,architecture` for every finding two agents raised.
        findingsByAgent: findingCountsByAgent(db, { includeSuppressed: true }),
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

  server.registerTool(
    "get_findings",
    {
      title: "Get findings",
      description:
        "Findings for a review, including the ones triage suppressed. Suppressed findings are " +
        "the interesting ones when tuning thresholds: they are what Maestro decided not to say.",
      inputSchema: {
        reviewId: z.string(),
        includeSuppressed: z.boolean().optional(),
        minSeverity: z.enum(["critical", "high", "medium", "low", "info"]).optional(),
      },
    },
    async ({ reviewId, includeSuppressed, minSeverity }) => {
      const rows = db
        .prepare(
          `SELECT id, agent_id, file, line_start, line_end, category, severity, confidence,
                  title, body, agreement_count, status, suppressed_reason
           FROM findings WHERE review_id = ?
           ORDER BY confidence DESC`,
        )
        .all(reviewId) as Record<string, unknown>[];

      const filtered = rows.filter((r) => {
        if (!includeSuppressed && r.status === "suppressed") return false;
        if (minSeverity && !severityAtLeast(String(r.severity), minSeverity)) return false;
        return true;
      });
      return text({ reviewId, count: filtered.length, findings: filtered });
    },
  );

  server.registerTool(
    "trigger_review",
    {
      title: "Trigger review",
      description:
        "Queue a review of a pull request. Returns immediately with a job id: reviews take " +
        "minutes, so this enqueues work for a running `maestro serve` rather than blocking. " +
        "Requires the daemon to be running; nothing drains the queue without it.",
      inputSchema: {
        url: z.string().describe("Pull request URL, e.g. https://github.com/owner/repo/pull/412"),
      },
    },
    async ({ url }) => {
      const pr = parsePullRequestRef(url);
      if (!pr) {
        return text({
          ok: false,
          error: `could not parse a pull request from '${url}'`,
        });
      }

      // `dedupe_key` is unique across the whole jobs table and rows are never pruned, so
      // a fixed per-pull-request key meant `trigger_review` worked exactly once for each
      // pull request, for ever — the second call inserted nothing and reported success.
      // The webhook path had the same bug for comment triggers; this is the same fix,
      // one call site over. Random rather than a timestamp: two calls in the same
      // millisecond collided on the key and the second silently vanished, which is the
      // bug being fixed reappearing as a flaky test. Idempotency lives in the pending
      // check below, so this key only has to be unique.
      // Not the queue's dedupe key: that is permanent, so a fixed per-pull-request key
      // meant the second call inserted nothing and still reported success. This asks the
      // question actually worth asking — is one already queued or running — which lets a
      // later call work while still refusing to stack two reviews of the same pull
      // request.
      const jobId = hasPendingReviewJob(db, pr)
        ? null
        : new JobQueue(db, "mcp").enqueue({
            kind: "review-pr",
            // Asked for by hand, so it re-reviews rather than reporting that this SHA
            // was already covered.
            payload: { ...pr, force: true },
            dedupeKey: `${pr.owner}/${pr.repo}#${pr.number}@mcp-${randomUUID()}`,
          });

      // A lease in the future means a worker is alive and claiming work. The COUNT(*)
      // form this replaces always returns a row, so the boolean was always true — a
      // fabricated signal, the same defect as printing 0.00 cost for an unpriced provider.
      const leased = db
        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE locked_until > ?")
        .get(new Date().toISOString()) as { n: number } | undefined;

      return text({
        ok: true,
        queued: Boolean(jobId),
        jobId,
        pr,
        note: jobId
          ? "queued; `maestro serve` must be running to pick it up"
          : "already queued for this pull request",
        // Evidence of a live worker, not proof of one: an idle daemon holds no lease.
        workersActive: (leased?.n ?? 0) > 0,
      });
    },
  );

  server.registerTool(
    "run_eval",
    {
      title: "Run eval",
      description:
        "Score stored eval fixtures and report precision, recall and miss rate per playbook " +
        "version. Reads scores already recorded by `maestro eval`; it does not itself run " +
        "reviews, because those take minutes and cost money.",
      inputSchema: { fixture: z.string().optional() },
    },
    async ({ fixture }) => {
      const dir = scoresDir(maestroHome());
      let scores: EvalScore[];
      try {
        scores = loadScores(dir);
      } catch {
        scores = [];
      }
      const selected = fixture ? scores.filter((s) => s.fixture === fixture) : scores;

      if (!selected.length) {
        return text({
          scores: [],
          comparisons: [],
          note: fixture
            ? `no recorded scores for fixture '${fixture}' - run 'maestro eval run ${fixture}'`
            : "no recorded scores - add a fixture with 'maestro eval add' and run 'maestro eval run'",
        });
      }
      return text({ scores: selected, comparisons: compareVersions(selected) });
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
