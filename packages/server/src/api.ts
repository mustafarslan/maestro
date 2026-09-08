import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { JobQueue, type SqlDatabase } from "@maestro/core";
import { ModelCatalog, ProviderConfigStore } from "@maestro/llm";
import { NODE_SPECS, PlaybookStore, safeParsePlaybook } from "@maestro/playbook";

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
        findings: ctx.db
          .prepare("SELECT * FROM findings WHERE review_id=? ORDER BY severity")
          .all(id),
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
      byAgent: ctx.db
        .prepare(`SELECT agent_id, status, COUNT(*) AS n FROM findings GROUP BY agent_id, status`)
        .all(),
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
      const raw = await readBody(req);
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 4 * 1024 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}
