import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, ReviewStore, type SqlDatabase } from "@maestro/core";
import { defaultPlaybook, PlaybookStore } from "@maestro/playbook";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

let db: SqlDatabase;
let reviewId: string;

/** Drives the server through a real MCP client, not by calling handlers directly. */
async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([
    client.connect(clientTransport),
    buildServer({ db }).connect(serverTransport),
  ]);
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
  };
  return JSON.parse(res.content[0]?.text ?? "{}");
};

beforeEach(async () => {
  db = await openStore({ path: ":memory:" });
  const version = new PlaybookStore(db).publish(defaultPlaybook());
  reviewId = new ReviewStore(db).create({
    repoOwner: "acme",
    repoName: "web",
    prNumber: 41,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    baseRef: "main",
    title: "A change",
    author: "someone",
    isFork: false,
    playbookVersionId: version.id,
  }).id;

  const insert = db.prepare(
    `INSERT INTO findings (id, review_id, agent_id, file, line_start, line_end, category,
                           severity, confidence, title, body, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  insert.run(
    "f1",
    reviewId,
    "security",
    "a.ts",
    10,
    10,
    "idor",
    "critical",
    0.9,
    "IDOR",
    "b",
    "posted",
    now,
  );
  insert.run(
    "f2",
    reviewId,
    "ui-ux",
    "b.tsx",
    5,
    5,
    "a11y",
    "low",
    0.4,
    "Label",
    "b",
    "suppressed",
    now,
  );
});

describe("get_findings", () => {
  it("hides suppressed findings unless they are asked for", async () => {
    // Suppressed findings are the interesting ones when tuning thresholds — they are
    // what Maestro decided not to say — but they are not what a reviewer wants by default.
    const client = await connect();
    const visible = await call(client, "get_findings", { reviewId });
    expect(visible.findings.map((f: { id: string }) => f.id)).toEqual(["f1"]);

    const all = await call(client, "get_findings", { reviewId, includeSuppressed: true });
    expect(all.findings.map((f: { id: string }) => f.id).sort()).toEqual(["f1", "f2"]);
  });

  it("filters by severity floor, not by exact match", async () => {
    const client = await connect();
    const high = await call(client, "get_findings", {
      reviewId,
      includeSuppressed: true,
      minSeverity: "high",
    });
    // critical passes a "high" floor; low does not.
    expect(high.findings.map((f: { id: string }) => f.id)).toEqual(["f1"]);
  });
});

describe("trigger_review", () => {
  it("queues a job the daemon can claim", async () => {
    const client = await connect();
    const res = await call(client, "trigger_review", {
      url: "https://github.com/acme/web/pull/41",
    });
    expect(res.ok).toBe(true);
    expect(res.queued).toBe(true);
    expect(res.pr).toMatchObject({ owner: "acme", repo: "web", number: 41 });

    const row = db.prepare("SELECT kind, state FROM jobs WHERE id=?").get(res.jobId);
    expect(row).toMatchObject({ kind: "review-pr", state: "queued" });

    // No daemon in this test, so nothing holds a lease. A COUNT(*) based check would
    // have reported a live worker regardless, which is a fabricated signal.
    expect(res.workersActive).toBe(false);
  });

  it("collapses a second trigger for the same PR instead of racing the webhook", async () => {
    const client = await connect();
    await call(client, "trigger_review", { url: "https://github.com/acme/web/pull/41" });
    const second = await call(client, "trigger_review", {
      url: "https://github.com/acme/web/pull/41",
    });
    expect(second.queued).toBe(false);
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number };
    expect(n).toBe(1);
  });

  it("triggers again once the first review is no longer pending", async () => {
    // The dedupe key used to be a fixed `#41@latest`, which is unique across the whole
    // jobs table and never pruned — so `trigger_review` worked exactly once per pull
    // request, for ever, and every later call reported success having inserted nothing.
    const client = await connect();
    await call(client, "trigger_review", { url: "https://github.com/acme/web/pull/41" });
    db.prepare("UPDATE jobs SET state='done'").run();
    const second = await call(client, "trigger_review", {
      url: "https://github.com/acme/web/pull/41",
    });
    expect(second.queued).toBe(true);
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number };
    expect(n).toBe(2);
  });

  it("reports a parse failure rather than queueing nonsense", async () => {
    const client = await connect();
    const res = await call(client, "trigger_review", { url: "not a pull request" });
    expect(res.ok).toBe(false);
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number };
    expect(n).toBe(0);
  });
});

describe("run_eval", () => {
  it("says what to do instead of returning an empty report", async () => {
    // An empty array reads like "your playbook scores zero"; it actually means no
    // fixtures have been run.
    // MAESTRO_HOME is pointed at an empty directory so "no fixtures have been run" is
    // built rather than assumed. `run_eval` reads scores from the real home, so this
    // passed only on a machine where the golden set had never been used.
    const home = process.env.MAESTRO_HOME;
    process.env.MAESTRO_HOME = mkdtempSync(join(tmpdir(), "maestro-eval-empty-"));
    let res: Awaited<ReturnType<typeof call>>;
    try {
      const client = await connect();
      res = await call(client, "run_eval", {});
    } finally {
      if (home === undefined) delete process.env.MAESTRO_HOME;
      else process.env.MAESTRO_HOME = home;
    }
    expect(res.scores).toEqual([]);
    // Against the CLI's own command list rather than against a spelling written here.
    // This assertion used to read /maestro evaluate/ — the command is `maestro eval`,
    // and the CLI answers the longer spelling with a usage error. The test had locked in
    // the mistake it was meant to guard, and told a model to type it.
    const source = readFileSync(
      join(import.meta.dirname, "../../../apps/cli/src/index.ts"),
      "utf8",
    );
    const accepted = new Set([...source.matchAll(/case "([\w-]+)":/g)].map((m) => m[1]));
    for (const m of String(res.note).matchAll(/maestro ([a-z][\w-]*)/g)) {
      expect(accepted, `run_eval tells the caller to run 'maestro ${m[1]}'`).toContain(m[1]);
    }
    expect(res.note).toMatch(/maestro eval/);
  });
});

describe("tool surface", () => {
  it("exposes every tool the plan specified", async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    for (const expected of [
      "dismiss_finding",
      "explain_finding",
      "get_findings",
      "get_playbook",
      "get_review",
      "list_reviews",
      "run_eval",
      "set_agent_model",
      "trigger_review",
      "update_persona",
    ]) {
      expect(names).toContain(expected);
    }
  });
});

describe("an id that does not exist says so", () => {
  /**
   * The caller here is a model, which acts on what it is told. "This review exists and
   * has nothing in it" and "there is no such review" lead to different next moves, and
   * only one of them was true.
   */
  const raw = async (client: Client, name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text: string }[];
    };
    return res.content[0]?.text ?? "";
  };

  it("get_review does not report an empty review for an id that is not one", async () => {
    const client = await connect();
    expect(await raw(client, "get_review", { reviewId: "nope" })).toContain("no review with id");
  });

  it("get_review still returns the review when there is one", async () => {
    // The other half: a handler that always said "no review" would pass the test above.
    const client = await connect();
    expect(await raw(client, "get_review", { reviewId })).toContain(reviewId);
  });

  it("dismiss_finding does not report success for a finding that does not exist", async () => {
    // This tool is the feedback signal precision is measured from. A dismissal that
    // silently lands nowhere makes that number quietly wrong, and the person who typed
    // the id slightly wrong is told it worked.
    const client = await connect();
    const said = await raw(client, "dismiss_finding", { findingId: "nope", reason: "x" });
    expect(said).toContain("no finding with id");
    expect(said).not.toContain('"ok": true');
  });

  it("dismiss_finding does dismiss one that exists", async () => {
    const client = await connect();
    db.prepare(
      `INSERT INTO findings (id, review_id, agent_id, category, severity, confidence, title, body, created_at)
       VALUES ('fd-1', ?, 'security', 'bug', 'high', 0.9, 't', 'b', ?)`,
    ).run(reviewId, new Date().toISOString());

    expect(
      await raw(client, "dismiss_finding", { findingId: "fd-1", reason: "not real" }),
    ).toContain('"ok": true');
    expect(
      db.prepare("SELECT status FROM findings WHERE id='fd-1'").get<{ status: string }>()?.status,
    ).toBe("dismissed");

    // And it reaches the table the quality loop is measured from. This tool wrote the
    // status alone, so the most deliberate feedback signal in the system was invisible to
    // every query that reads `feedback` — two paths against one schema, disagreeing about
    // whether the same verdict had been given.
    const fb = db
      .prepare("SELECT signal FROM feedback WHERE finding_id='fd-1'")
      .all<{ signal: string }>();
    expect(fb.map((r) => r.signal)).toEqual(["thumbs_down"]);
  });
});
