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
