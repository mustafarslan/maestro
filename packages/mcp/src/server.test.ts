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
    const client = await connect();
    const res = await call(client, "run_eval", {});
    expect(res.scores).toEqual([]);
    expect(res.note).toMatch(/maestro evaluate/);
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
