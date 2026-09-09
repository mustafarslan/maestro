import { openStore, ReviewStore, type SqlDatabase } from "@maestro/core";
import { defaultPlaybook, PlaybookStore } from "@maestro/playbook";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningAdmin, startAdminServer } from "./admin.js";

let db: SqlDatabase;
let admin: RunningAdmin;
let base: string;
const TOKEN = "test-token-abcdef";

beforeEach(async () => {
  db = await openStore({ path: ":memory:" });
  const pb = new PlaybookStore(db);
  pb.ensureDefault();
  new ReviewStore(db).create({
    repoOwner: "acme",
    repoName: "web",
    prNumber: 7,
    headSha: "deadbeef",
    title: "Add retries",
    playbookVersionId: pb.getActive("default")!.id,
  });
  admin = await startAdminServer({ db, port: 0, token: TOKEN });
  base = `http://127.0.0.1:${admin.port}`;
});

afterEach(async () => {
  await admin.close();
  db.close();
});

const auth = { authorization: `Bearer ${TOKEN}` };

describe("admin authentication", () => {
  it("refuses API access without a token", async () => {
    expect((await fetch(`${base}/api/reviews`)).status).toBe(401);
  });

  it("refuses a wrong token", async () => {
    const res = await fetch(`${base}/api/reviews`, { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  it("refuses a token that is a prefix of the real one", async () => {
    // Constant-time comparison also has to reject length mismatches explicitly.
    const res = await fetch(`${base}/api/reviews`, {
      headers: { authorization: `Bearer ${TOKEN.slice(0, 5)}` },
    });
    expect(res.status).toBe(401);
  });

  it("accepts the token in a query parameter, because EventSource cannot set headers", async () => {
    const res = await fetch(`${base}/api/reviews?token=${TOKEN}`);
    expect(res.status).toBe(200);
  });

  it("guards the event stream too", async () => {
    expect((await fetch(`${base}/api/events`)).status).toBe(401);
  });

  it("serves the UI shell without a token, since the UI itself asks for one", async () => {
    // The bundle contains no data; every data path is guarded.
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<!doctype html>");
  });
});

describe("admin API", () => {
  it("lists reviews joined to their repository", async () => {
    const res = await fetch(`${base}/api/reviews`, { headers: auth });
    const body = (await res.json()) as {
      reviews: { owner: string; repo: string; title: string }[];
    };
    expect(body.reviews).toHaveLength(1);
    expect(body.reviews[0]).toMatchObject({ owner: "acme", repo: "web", title: "Add retries" });
  });

  it("returns the active playbook and the node registry", async () => {
    const res = await fetch(`${base}/api/playbook`, { headers: auth });
    const body = (await res.json()) as {
      active: { version: number; doc: { agents: { id: string }[] } };
      nodeRegistry: { kind: string }[];
    };
    expect(body.active.version).toBe(1);
    expect(body.active.doc.agents.map((a) => a.id)).toContain("security");
    expect(body.nodeRegistry.map((n) => n.kind)).toContain("prepare-env");
  });

  it("rejects an invalid playbook rather than publishing it", async () => {
    // Server-side validation is what stops a bad graph reaching the engine, regardless
    // of which client sent it.
    const doc = defaultPlaybook();
    doc.graph.edges.push({ from: "triage", to: "route" });
    const res = await fetch(`${base}/api/playbook`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ document: doc }),
    });
    const body = (await res.json()) as { ok: boolean; issues: { code: string }[] };

    expect(body.ok).toBe(false);
    expect(body.issues.map((i) => i.code)).toContain("cycle");
    expect(new PlaybookStore(db).listVersions()).toHaveLength(1);
  });

  it("publishes a valid edit as a new version", async () => {
    const doc = defaultPlaybook();
    doc.agents[0]!.persona = "a new persona";
    const res = await fetch(`${base}/api/playbook`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ document: doc, notes: "test" }),
    });
    const body = (await res.json()) as { ok: boolean; version: number };

    expect(body).toMatchObject({ ok: true, version: 2 });
    expect(new PlaybookStore(db).getActive("default")?.doc.agents[0]?.persona).toBe(
      "a new persona",
    );
  });

  it("rolls back to an earlier version", async () => {
    const store = new PlaybookStore(db);
    const v1 = store.getActive("default")!;
    const doc = defaultPlaybook();
    doc.description = "v2";
    store.publish(doc);

    const res = await fetch(`${base}/api/playbook/activate`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ versionId: v1.id }),
    });

    expect(res.status).toBe(200);
    expect(store.getActive("default")?.id).toBe(v1.id);
  });

  it("rejects malformed JSON with a 400 rather than a stack trace", async () => {
    const res = await fetch(`${base}/api/playbook`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown API path", async () => {
    const res = await fetch(`${base}/api/nope`, { headers: auth });
    expect(res.status).toBe(404);
  });

  it("falls back to the UI shell for client-side routes", async () => {
    const res = await fetch(`${base}/some/spa/route`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("sets nosniff on served assets", async () => {
    const res = await fetch(`${base}/`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("the feedback endpoint the quality view reads", () => {
  it("groups findings by agent and status, which is what precision is measured from", async () => {
    // Phase 9's whole point: the comment never claims its own accuracy, because that
    // needs human judgement that has not happened when it is written. It is gathered
    // afterwards and shown only here. The endpoint existed and served this from the
    // first day; nothing in the UI called it, so the loop was invisible.
    const reviewId = (db.prepare("SELECT id FROM reviews LIMIT 1").get() as { id: string }).id;
    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO findings (id, review_id, agent_id, category, severity, confidence,
                             title, body, status, created_at)
       VALUES (?, ?, ?, 'c', 'high', 0.9, 't', 'b', ?, ?)`,
    );
    insert.run("q1", reviewId, "security", "accepted", now);
    insert.run("q2", reviewId, "security", "dismissed", now);
    insert.run("q3", reviewId, "product", "suppressed", now);

    const res = await fetch(`${base}/api/findings/feedback`, { headers: auth });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      byAgent: { agent_id: string; status: string; n: number }[];
    };
    const find = (a: string, st: string) =>
      body.byAgent.find((r) => r.agent_id === a && r.status === st)?.n ?? 0;

    expect(find("security", "accepted")).toBe(1);
    expect(find("security", "dismissed")).toBe(1);
    // Suppressed findings were never shown to anyone, so they must stay distinguishable
    // from a human verdict rather than being folded into one.
    expect(find("product", "suppressed")).toBe(1);
    expect(find("product", "accepted")).toBe(0);
  });

  it("requires a token, like every other admin route", async () => {
    expect((await fetch(`${base}/api/findings/feedback`)).status).toBe(401);
  });
});

describe("request body limits", () => {
  it("refuses an oversized body with 413 rather than a generic failure", async () => {
    // The limit existed but bounded nothing: rejecting the promise left the data
    // listener running, so the string kept growing for as long as the client kept
    // sending. The webhook receiver destroyed the request; this path did not.
    const res = await fetch(`${base}/api/playbook`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ document: { pad: "x".repeat(5 * 1024 * 1024) } }),
    }).catch(() => undefined);

    // Destroying the socket can surface either as a 413 or as a transport error at the
    // client; both mean the server stopped reading, which is the point.
    if (res) expect([413, 400]).toContain(res.status);
  });

  it("still accepts a normal body afterwards", async () => {
    // A rejected request must not leave the listener in a state that breaks the next one.
    const res = await fetch(`${base}/api/playbook/validate`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ document: {} }),
    });
    expect(res.status).toBe(200);
  });

  it("answers 400, not 500, for a body that is not JSON", async () => {
    const res = await fetch(`${base}/api/playbook/validate`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});
