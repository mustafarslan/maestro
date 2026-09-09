import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  bySeverity,
  JobQueue,
  LIVE_ENVIRONMENT_STATES,
  maestroHome,
  type SqlDatabase,
} from "@maestro/core";
import { compareVersions, type EvalScore, fixturesDir, loadScores } from "@maestro/engine";
import { agentQuality, findingCountsByAgent } from "@maestro/integrations";
import { ModelCatalog, ProviderConfigStore, runConformance } from "@maestro/llm";
import { diffPlaybooks, NODE_SPECS, PlaybookStore, safeParsePlaybook } from "@maestro/playbook";

export interface ApiContext {
  db: SqlDatabase;
  token: string;
  /** Emits an SSE event to every connected admin client. */
  broadcast: (event: string, data: unknown) => void;
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: (
    ctx: ApiContext,
    req: IncomingMessage,
    match: RegExpExecArray,
    body: unknown,
  ) => Promise<unknown>;
}

/** Constant-time compare so a token cannot be recovered by timing the endpoint. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authorize(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (bearer && tokenMatches(bearer, token)) return true;
  const url = new URL(req.url ?? "/", "http://localhost");
  const query = url.searchParams.get("token") ?? "";
  // EventSource cannot set headers, so SSE has to accept the token in the query string.
  return Boolean(query) && tokenMatches(query, token);
}

const routes: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/reviews$/,
    handler: async (ctx) => ({
      reviews: ctx.db
        .prepare(
          `SELECT r.id, r.pr_number, r.head_sha, r.title, r.author, r.state, r.cost_cents,
                  r.created_at, r.finished_at, repos.owner, repos.name AS repo
           FROM reviews r JOIN repos ON repos.id = r.repo_id
           ORDER BY r.created_at DESC LIMIT 100`,
        )
        .all(),
    }),
  },
  {
    method: "GET",
    pattern: /^\/api\/reviews\/([\w-]+)$/,
    handler: async (ctx, _req, m) => {
      const id = m[1] as string;
      return {
        review: ctx.db.prepare("SELECT * FROM reviews WHERE id=?").get(id),
        tasks: ctx.db.prepare("SELECT * FROM tasks WHERE review_id=? ORDER BY created_at").all(id),
        // Sorted here for the same reason as the carried findings: `ORDER BY severity` on
        // a TEXT column is alphabetical, so the UI listed `medium` below `info`.
        findings: ctx.db
          .prepare("SELECT * FROM findings WHERE review_id=?")
          .all<{ severity: string }>(id)
          .sort(bySeverity),
        spans: ctx.db.prepare("SELECT * FROM spans WHERE review_id=? ORDER BY started_at").all(id),
        llmCalls: ctx.db
          .prepare(
            `SELECT provider_id, model, COUNT(*) AS steps, SUM(tokens_in) AS tokens_in,
                    SUM(tokens_out) AS tokens_out, SUM(cost_cents) AS cost_cents
             FROM llm_calls WHERE review_id=? GROUP BY provider_id, model`,
          )
          .all(id),
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/playbook$/,
    handler: async (ctx) => {
      const store = new PlaybookStore(ctx.db);
      return {
        active: store.getActive("default"),
        versions: store.listVersions("default").map((v) => ({
          id: v.id,
          version: v.version,
          notes: v.notes,
          createdAt: v.createdAt,
        })),
        nodeRegistry: Object.values(NODE_SPECS),
      };
    },
  },
  {
    // What publishing this version changed, or what rolling back would undo. The plan
    // names a diff twice — version management, and the persona editor — and neither
    // existed: publishing was a one-way door with no way to see what moved.
    method: "GET",
    pattern: /^\/api\/playbook\/diff$/,
    handler: async (ctx, req) => {
      const store = new PlaybookStore(ctx.db);
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const versions = store.listVersions("default");

      // Defaults to "the active version against the one before it", which is the question
      // somebody has when they open the page.
      const toId = url.searchParams.get("to") ?? store.getActive("default")?.id;
      const to = toId ? store.getVersion(toId) : null;
      const fromId =
        url.searchParams.get("from") ??
        versions.find((v) => v.version === (to?.version ?? 0) - 1)?.id;
      const from = fromId ? store.getVersion(fromId) : null;

      if (!to || !from) {
        // A first version has nothing to compare against, and saying so is better than an
        // empty list that reads as "nothing changed".
        return { changes: [], from: from?.version ?? null, to: to?.version ?? null };
      }
      return {
        from: from.version,
        to: to.version,
        changes: diffPlaybooks(from.doc, to.doc),
      };
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/playbook$/,
    handler: async (ctx, _req, _m, body) => {
      // Validation happens here, not in the browser: an invalid graph must never reach
      // the engine, and the editor is not the only client.
      const result = safeParsePlaybook((body as { document?: unknown })?.document);
      if (!result.ok) return { ok: false, issues: result.issues };
      const record = new PlaybookStore(ctx.db).publish(result.doc, {
        notes: (body as { notes?: string })?.notes ?? "edited in Studio",
        activate: (body as { activate?: boolean })?.activate !== false,
      });
      ctx.broadcast("playbook", { versionId: record.id, version: record.version });
      return { ok: true, version: record.version, id: record.id };
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/playbook\/validate$/,
    handler: async (_ctx, _req, _m, body) => {
      const result = safeParsePlaybook((body as { document?: unknown })?.document);
      return result.ok ? { ok: true } : { ok: false, issues: result.issues };
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/playbook\/activate$/,
    handler: async (ctx, _req, _m, body) => {
      new PlaybookStore(ctx.db).activate((body as { versionId: string }).versionId);
      ctx.broadcast("playbook", { activated: (body as { versionId: string }).versionId });
      return { ok: true };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/providers$/,
    handler: async (ctx) => ({
      providers: new ProviderConfigStore(ctx.db).list(),
      models: new ModelCatalog(ctx.db).list(),
    }),
  },
  {
    // Phase 9's other half. `compareVersions` has existed since the eval harness landed
    // and only the CLI and MCP could reach it, so "the UI shows a version-versus-version
    // comparison" — the plan's stated exit for the quality loop — was true of neither.
    //
    // Reads recorded scores; it does not run reviews. Running the golden set takes
    // minutes and spends money, and a button that quietly does that is not a button.
    method: "GET",
    pattern: /^\/api\/eval$/,
    handler: async () => {
      let scores: EvalScore[] = [];
      try {
        scores = loadScores(fixturesDir(maestroHome()));
      } catch {
        // No fixtures directory yet is the ordinary state of a fresh install.
      }
      return { scores, comparisons: compareVersions(scores) };
    },
  },
  {
    // "Test connection", which the plan puts on the model picker. One real round trip
    // through the provider, because that is the only thing that answers the question: a
    // reachability check that does not call the model passes for a model that cannot use
    // tools, and binding a review agent to one of those fails at run time instead.
    method: "POST",
    pattern: /^\/api\/providers\/test$/,
    handler: async (ctx, _req, _m, body) => {
      const { providerId, model } = (body ?? {}) as { providerId?: string; model?: string };
      if (!providerId || !model) return { ok: false, error: "providerId and model are required" };

      const provider = (await new ProviderConfigStore(ctx.db).buildRegistry()).get(providerId);
      if (!provider) {
        return { ok: false, error: `no credential configured for provider '${providerId}'` };
      }
      try {
        return { ok: true, report: await runConformance(provider, model) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    // The environments view the plan's observability phase names: what is running now,
    // when its lease expires, and what the reaper has left behind. Container leaks are a
    // listed risk and `maestro doctor` only counts strays — this says which review each
    // one belongs to, which is what makes a leak actionable rather than a number.
    method: "GET",
    pattern: /^\/api\/environments$/,
    handler: async (ctx) => ({
      environments: ctx.db
        .prepare(
          `SELECT e.id, e.review_id, e.kind, e.agent_id, e.container_id, e.image_id, e.workdir,
                  e.state, e.lease_until, e.ttl_at, e.created_at, e.destroyed_at,
                  repos.owner || '/' || repos.name AS repo, r.pr_number, r.state AS review_state
             FROM environments e
             JOIN reviews r ON r.id = e.review_id
             JOIN repos ON repos.id = r.repo_id
            ORDER BY
              -- Live and leaked first: those are the rows anybody opens this page for.
              CASE e.state WHEN 'leaked' THEN 0 WHEN 'running' THEN 1 ELSE 2 END,
              e.created_at DESC
            LIMIT 200`,
        )
        .all<{ state: string }>()
        // Decided here, from the one definition, so the browser bundle needs no copy of a
        // vocabulary it cannot import.
        .map((row) => ({
          ...row,
          live: (LIVE_ENVIRONMENT_STATES as readonly string[]).includes(row.state),
        })),
    }),
  },
  {
    method: "GET",
    pattern: /^\/api\/stats$/,
    handler: async (ctx) => {
      const queue = new JobQueue(ctx.db);
      return {
        queue: queue.stats(),
        reviews: ctx.db.prepare("SELECT state, COUNT(*) AS n FROM reviews GROUP BY state").all(),
        environments: ctx.db
          .prepare("SELECT state, COUNT(*) AS n FROM environments GROUP BY state")
          .all(),
        spend: ctx.db
          .prepare(
            `SELECT provider_id, model, SUM(cost_cents) AS cost_cents, COUNT(*) AS calls
             FROM llm_calls GROUP BY provider_id, model`,
          )
          .all(),
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/findings\/feedback$/,
    handler: async (ctx) => ({
      // Through the shared splitter, not a raw GROUP BY: `agent_id` holds a comma-joined
      // list whenever triage merged what several agents reported, so grouping on the
      // column invented agents named `security,architecture` and lost the real ones.
      byAgent: findingCountsByAgent(ctx.db, { includeSuppressed: true }).map((r) => ({
        agent_id: r.agentId,
        status: r.status,
        n: r.n,
      })),
      // The same numbers reduced to a per-agent acceptance rate. `agentQuality` was
      // written for this and had no callers, while this endpoint reimplemented half of
      // it — two answers to one question, and the one with the careful "no data is not
      // 0%" handling was the dead one.
      quality: agentQuality(ctx.db),
    }),
  },
];

export async function handleApi(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/")) return false;

  if (!authorize(req, ctx.token)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return true;
  }

  for (const route of routes) {
    const match = route.pattern.exec(url.pathname);
    if (!match || route.method !== req.method) continue;

    let body: unknown;
    if (req.method === "POST") {
      let raw: string;
      try {
        raw = await readBody(req);
      } catch (err) {
        // An oversized body is the client's error, not ours; answering 500 sends someone
        // looking for a server fault that is not there.
        const tooLarge = err instanceof BodyTooLargeError;
        res.writeHead(tooLarge ? 413 : 400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: tooLarge ? "request body too large" : "unreadable body" }));
        return true;
      }
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid json" }));
        return true;
      }
    }

    try {
      const out = await route.handler(ctx, req, match, body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
  return true;
}

export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Thrown rather than a plain Error so the caller can answer 413 instead of 500. */
export class BodyTooLargeError extends Error {
  constructor() {
    super(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    this.name = "BodyTooLargeError";
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let settled = false;
    req.on("data", (c) => {
      if (settled) return;
      raw += c;
      if (raw.length > MAX_BODY_BYTES) {
        settled = true;
        // Rejecting alone does not stop the stream: the data listener keeps firing and
        // the string keeps growing for as long as the client keeps sending, so the limit
        // bounds nothing. Destroying the request is what actually stops it — the webhook
        // receiver already did this; the admin API had the same code without the destroy.
        raw = "";
        req.destroy();
        reject(new BodyTooLargeError());
      }
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(raw);
      }
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}
