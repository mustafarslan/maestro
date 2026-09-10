import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("returns a per-agent acceptance rate the UI does not have to recompute", async () => {
    // `agentQuality` was written for this and had no callers, while the endpoint
    // reimplemented half of it — two answers to one question, and the dead one was the
    // one with the careful "no data is not 0%" handling.
    const reviewId = (db.prepare("SELECT id FROM reviews LIMIT 1").get() as { id: string }).id;
    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO findings (id, review_id, agent_id, category, severity, confidence,
                             title, body, status, created_at)
       VALUES (?, ?, ?, 'c', 'high', 0.9, 't', 'b', ?, ?)`,
    );
    insert.run("r1", reviewId, "security", "accepted", now);
    insert.run("r2", reviewId, "security", "accepted", now);
    insert.run("r3", reviewId, "security", "dismissed", now);
    insert.run("r4", reviewId, "ui-ux", "posted", now);

    const res = await fetch(`${base}/api/findings/feedback`, { headers: auth });
    const body = (await res.json()) as {
      quality: { agentId: string; acceptanceRate?: number }[];
    };

    const security = body.quality.find((q) => q.agentId === "security");
    expect(security?.acceptanceRate).toBeCloseTo(2 / 3, 5);

    // An agent nobody has ruled on has no rate at all, rather than 0%.
    const uiux = body.quality.find((q) => q.agentId === "ui-ux");
    expect(uiux?.acceptanceRate).toBeUndefined();
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

describe("the environments endpoint the operator view reads", () => {
  const seedEnv = (id: string, state: string, over: Record<string, unknown> = {}) => {
    const reviewId = db.prepare("SELECT id FROM reviews LIMIT 1").get<{ id: string }>()?.id;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO environments (id, review_id, kind, agent_id, container_id, workdir, state,
                                 spec_json, lease_until, ttl_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      reviewId,
      (over.kind as string) ?? "analyze",
      (over.agent_id as string) ?? "security",
      `container-${id}`,
      "/w",
      state,
      "{}",
      now,
      now,
      now,
    );
  };

  it("joins each environment to the pull request it belongs to", async () => {
    // A stray container is a number until you know whose it is. `maestro doctor` counts
    // them; this is what makes one actionable.
    seedEnv("e1", "running");
    const res = await fetch(`${base}/api/environments`, { headers: auth });
    const body = (await res.json()) as { environments: { repo: string; pr_number: number }[] };
    expect(body.environments[0]).toMatchObject({ repo: "acme/web", pr_number: 7 });
  });

  it("puts leaked and running environments above finished ones", async () => {
    // Anybody opening this page is looking for what is still holding disk.
    seedEnv("e-done", "destroyed");
    seedEnv("e-live", "running");
    seedEnv("e-leak", "leaked");
    const res = await fetch(`${base}/api/environments`, { headers: auth });
    const body = (await res.json()) as { environments: { id: string }[] };
    expect(body.environments.map((e) => e.id)).toEqual(["e-leak", "e-live", "e-done"]);
  });

  it("needs the token like everything else", async () => {
    const res = await fetch(`${base}/api/environments`);
    expect(res.status).toBe(401);
  });
});

describe("the endpoints the Studio and Quality views need", () => {
  it("serves the golden-set comparison the quality loop is measured by", async () => {
    // `compareVersions` existed since the eval harness landed and only the CLI and MCP
    // could reach it, so "the UI shows a version-versus-version comparison" was true of
    // neither surface. An install with no fixtures answers with empty lists rather than
    // an error, because that is the ordinary state of a fresh one.
    //
    // MAESTRO_HOME is pointed at an empty directory to *make* that the state. The
    // endpoint reads scores from the real home, so this assertion held only on a machine
    // where nobody had ever run `maestro eval` — it passed for two hundred commits and
    // failed the first time the golden set was actually used. A test whose subject is
    // "a fresh install" must build one rather than hope it is running on one.
    const home = process.env.MAESTRO_HOME;
    process.env.MAESTRO_HOME = mkdtempSync(join(tmpdir(), "maestro-eval-empty-"));
    try {
      const res = await fetch(`${base}/api/eval`, { headers: auth });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { scores: unknown[]; comparisons: unknown[] };
      expect(body.scores).toEqual([]);
      expect(body.comparisons).toEqual([]);
    } finally {
      if (home === undefined) delete process.env.MAESTRO_HOME;
      else process.env.MAESTRO_HOME = home;
    }
  });

  it("refuses a connection test with no model rather than guessing one", async () => {
    const res = await fetch(`${base}/api/providers/test`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ providerId: "anthropic" }),
    });
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/model/);
  });

  it("says which provider has no credential instead of failing obscurely", async () => {
    // This is the common case on a fresh install, and it is the answer that tells
    // somebody what to do next rather than showing them a stack trace.
    const res = await fetch(`${base}/api/providers/test`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ providerId: "nonexistent", model: "m" }),
    });
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/no credential configured for provider 'nonexistent'/);
  });

  it("keeps both behind the token", async () => {
    expect((await fetch(`${base}/api/eval`)).status).toBe(401);
    expect((await fetch(`${base}/api/providers/test`, { method: "POST" })).status).toBe(401);
  });
});

describe("serving the embedded UI", () => {
  // These headers are invisible to a unit test of the asset map and to `doctor`, and wrong
  // ones are the kind of thing that breaks a UI for a year rather than immediately. Found
  // by serving the compiled binary and asking it for a route.
  it("never marks a client-side route immutable", async () => {
    // The test used to be `assetPath === "/index.html"`, so `/quality` — which IS
    // index.html, served for a route the SPA owns — took the immutable branch and was
    // cached for a year. After an upgrade a browser sitting there would keep serving the
    // old index, pointing at asset hashes that no longer exist, until somebody thought to
    // hard-reload.
    const res = await fetch(`${base}/quality`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("does not mark the index immutable either", async () => {
    const res = await fetch(`${base}/`);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("404s a hashed asset that does not exist rather than answering with HTML", async () => {
    // A browser asked for a script. Answering 200 with index.html gives it a MIME error
    // instead of a plain miss, and pins that answer for a year.
    const res = await fetch(`${base}/assets/index-STALEHASH.js`);
    expect(res.status).toBe(404);
  });

  it("serves a real hashed asset immutable, which is the point of hashing it", async () => {
    const index = await (await fetch(`${base}/`)).text();
    const href = /\/assets\/[^"']+\.js/.exec(index)?.[0];
    expect(href, "index.html should reference a hashed asset").toBeTruthy();

    const res = await fetch(`${base}${href}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  it("does not require the token, since the UI has to load before it can send one", async () => {
    expect((await fetch(`${base}/`)).status).toBe(200);
  });
});

describe("the playbook diff", () => {
  // The plan names a diff twice — version management, and the persona editor — and neither
  // existed. Publishing was a one-way door: you could roll back to a version and nothing
  // anywhere told you what rolling back would change.
  const publishWith = (mutate: (d: ReturnType<typeof defaultPlaybook>) => void) => {
    const doc = structuredClone(defaultPlaybook());
    mutate(doc);
    return new PlaybookStore(db).publish(doc, { activate: true });
  };

  it("compares the active version against the one before it by default", async () => {
    publishWith((d) => {
      const a = d.agents.find((x) => x.id === "security");
      if (a) a.persona = `${a.persona}\nAlways check authorisation on every handler.`;
    });

    const body = (await (await fetch(`${base}/api/playbook/diff`, { headers: auth })).json()) as {
      from: number;
      to: number;
      changes: { path: string }[];
    };
    expect(body.to).toBe(body.from + 1);
    expect(body.changes.some((c) => c.path === "agents.security.persona")).toBe(true);
  });

  it("says which versions it compared, so the answer is checkable", async () => {
    publishWith((d) => {
      d.triage.minConfidence = 0.95;
    });
    const body = (await (await fetch(`${base}/api/playbook/diff`, { headers: auth })).json()) as {
      from: number;
      to: number;
    };
    expect(typeof body.from).toBe("number");
    expect(typeof body.to).toBe("number");
  });

  it("reports an empty comparison rather than pretending nothing changed", async () => {
    // A first version has nothing before it. An empty `changes` with null bounds says that;
    // an empty `changes` alone would read as "identical".
    const body = (await (await fetch(`${base}/api/playbook/diff`, { headers: auth })).json()) as {
      from: number | null;
      changes: unknown[];
    };
    expect(body.changes).toEqual([]);
    expect(body.from).toBeNull();
  });

  it("needs the token", async () => {
    expect((await fetch(`${base}/api/playbook/diff`)).status).toBe(401);
  });
});
