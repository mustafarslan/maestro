import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newId, openStore, ReviewStore, type SqlDatabase } from "@maestro/core";
import { defaultPlaybook, PlaybookStore } from "@maestro/playbook";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningAdmin, startAdminServer } from "./admin.js";

/**
 * The admin UI declares the shape of every response it consumes, in
 * `packages/ui/src/api.ts`, by hand. Nothing has ever compared those declarations with what
 * the server actually sends.
 *
 * The drift is not hypothetical: `PlaybookDoc` was missing `automaticTriggers` and
 * `thinkingBudget` for as long as both existed, and this session added a `live` field to
 * the environments response that the UI had to be told about separately. A field the UI
 * expects and the server omits is `undefined` at render time — a blank column, or a throw
 * inside a `.map`, with nothing failing anywhere first.
 *
 * Crude on purpose, in the manner of `wiring.test.ts`: the interface is read as source
 * text, because the property is about two packages agreeing and TypeScript cannot see
 * across an HTTP boundary.
 */
const ROOT = join(import.meta.dirname, "../../..");
const API_TS = readFileSync(join(ROOT, "packages/ui/src/api.ts"), "utf8");

/** Required field names of an interface — optional ones may legitimately be absent. */
function requiredFields(name: string): string[] {
  const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(API_TS)?.[1];
  if (!body) throw new Error(`no interface ${name} in packages/ui/src/api.ts`);
  return [...body.matchAll(/^\s{2}(\w+)(\??):/gm)]
    .filter((m) => m[2] !== "?")
    .map((m) => m[1] as string);
}

let db: SqlDatabase;
let admin: RunningAdmin;
let base: string;
let reviewId: string;
const TOKEN = "contract-token";
const auth = { authorization: `Bearer ${TOKEN}` };

beforeEach(async () => {
  db = await openStore({ path: ":memory:" });
  const pb = new PlaybookStore(db);
  pb.publish(defaultPlaybook(), { activate: true });
  const now = new Date().toISOString();

  reviewId = new ReviewStore(db).create({
    repoOwner: "acme",
    repoName: "web",
    prNumber: 7,
    headSha: "a".repeat(40),
    title: "Add retries",
    author: "ada",
    playbookVersionId: pb.getActive("default")?.id as string,
  }).id;

  // Enough of a finished review that every row-shaped response has something in it.
  db.prepare("UPDATE reviews SET state='done', finished_at=?, cost_cents=12 WHERE id=?").run(
    now,
    reviewId,
  );
  db.prepare(
    `INSERT INTO findings (id, review_id, agent_id, file, line_start, line_end, category,
                           severity, confidence, title, body, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    newId("fd"),
    reviewId,
    "security",
    "a.ts",
    1,
    2,
    "idor",
    "high",
    0.9,
    "t",
    "b",
    "open",
    now,
  );
  // A feedback row, so the rollup's per-finding signals have a shape to check. Without
  // one the contract test would pass on an endpoint that never returns the field.
  {
    const findingId = db
      .prepare("SELECT id FROM findings WHERE review_id=?")
      .get<{ id: string }>(reviewId)?.id as string;
    db.prepare(
      "INSERT INTO feedback (id, finding_id, signal, actor, created_at) VALUES (?,?,?,?,?)",
    ).run(newId("fb"), findingId, "line_changed", null, now);
  }
  db.prepare(
    `INSERT INTO tasks (id, review_id, node_id, kind, agent_id, state, attempt, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(newId("tk"), reviewId, "n1", "agent", "security", "done", 1, now);
  db.prepare("INSERT INTO spans (id, review_id, name, status, started_at) VALUES (?,?,?,?,?)").run(
    newId("sp"),
    reviewId,
    "agent:security",
    "ok",
    now,
  );
  db.prepare(
    `INSERT INTO environments (id, review_id, kind, agent_id, container_id, workdir, state,
                               spec_json, lease_until, ttl_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(newId("env"), reviewId, "analyze", "security", "c1", "/w", "running", "{}", now, now, now);

  admin = await startAdminServer({ db, port: 0, token: TOKEN });
  base = `http://127.0.0.1:${admin.port}`;
});

afterEach(async () => {
  await admin.close();
  db.close();
});

const get = async (path: string) => (await fetch(`${base}${path}`, { headers: auth })).json();

/** Every field the UI requires must be present on the object the server actually sends. */
const expectShape = (name: string, actual: unknown) => {
  expect(actual, `${name}: the server sent nothing to check`).toBeTruthy();
  const keys = Object.keys(actual as object);
  const missing = requiredFields(name).filter((f) => !keys.includes(f));
  expect(
    missing,
    `packages/ui/src/api.ts declares ${name}.${missing.join(", ")} and the server does not send it`,
  ).toEqual([]);
};

describe("the admin API sends what the UI declares", () => {
  it("ReviewRow", async () => {
    const body = (await get("/api/reviews")) as { reviews: unknown[] };
    expectShape("ReviewRow", body.reviews[0]);
  });

  it("TaskRow, FindingRow and SpanRow", async () => {
    const body = (await get(`/api/reviews/${reviewId}`)) as Record<string, unknown[]>;
    expectShape("TaskRow", body.tasks?.[0]);
    expectShape("FindingRow", body.findings?.[0]);
    expectShape("SpanRow", body.spans?.[0]);
  });

  it("FeedbackRow, which the per-review rollup reads", async () => {
    const body = (await get(`/api/reviews/${reviewId}`)) as Record<string, unknown[]>;
    expectShape("FeedbackRow", body.feedback?.[0]);
  });

  it("EnvironmentRow", async () => {
    // The one this session changed: `live` is computed server-side now, and the UI was
    // told about it by hand.
    const body = (await get("/api/environments")) as { environments: unknown[] };
    expectShape("EnvironmentRow", body.environments[0]);
  });

  it("StatsResponse", async () => {
    expectShape("StatsResponse", await get("/api/stats"));
  });

  it("FeedbackResponse", async () => {
    expectShape("FeedbackResponse", await get("/api/findings/feedback"));
  });

  it("EvalResponse", async () => {
    expectShape("EvalResponse", await get("/api/eval"));
  });

  it("PlaybookResponse", async () => {
    expectShape("PlaybookResponse", await get("/api/playbook"));
  });

  it("ProvidersResponse", async () => {
    expectShape("ProvidersResponse", await get("/api/providers"));
  });
});

describe("the profiles page gets what it declares", () => {
  it("ProfilesResponse, ProfileRow and ProfileScores", async () => {
    const { ProfileStore } = await import("@maestro/profile");
    new ProfileStore(db).record("octocat", { "COG-01": "E" });
    const list = (await get("/api/profiles")) as { profiles: unknown[] };
    expectShape("ProfilesResponse", list);
    expectShape("ProfileRow", list.profiles[0]);
    const one = (await get("/api/profiles/octocat")) as { profile: { profile: unknown } };
    expectShape("ProfileRow", one.profile);
    expectShape("ProfileScores", one.profile.profile);
  });
});
