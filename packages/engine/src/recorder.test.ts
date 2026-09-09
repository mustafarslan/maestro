import { openStore, ReviewStore, type SqlDatabase } from "@maestro/core";
import { defaultPlaybook, PlaybookStore } from "@maestro/playbook";
import { beforeEach, describe, expect, it } from "vitest";
import type { NodeOutcome } from "./engine.js";
import { ReviewRecorder } from "./recorder.js";
import type { TriagedFinding } from "./triage.js";

let db: SqlDatabase;
let reviewId: string;
let recorder: ReviewRecorder;

const node = (over: Partial<NodeOutcome> = {}): NodeOutcome => ({
  nodeId: "n-security",
  kind: "agent",
  agentId: "security",
  state: "done",
  durationMs: 100,
  costCents: 1.5,
  ...over,
});

const finding = (over: Partial<TriagedFinding> = {}): TriagedFinding => ({
  file: "a.ts",
  lineStart: 1,
  category: "idor",
  severity: "high",
  confidence: 0.9,
  title: "t",
  body: "b",
  agentIds: ["security"],
  dedupeGroup: "a.ts@1#0",
  agreementCount: 1,
  ...over,
});

beforeEach(async () => {
  db = await openStore({ path: ":memory:" });
  const pb = new PlaybookStore(db).publish(defaultPlaybook());
  reviewId = new ReviewStore(db).create({
    repoOwner: "acme",
    repoName: "web",
    prNumber: 1,
    headSha: "abc",
    playbookVersionId: pb.id,
  }).id;
  recorder = new ReviewRecorder(db);
});

describe("ReviewRecorder", () => {
  it("returns the surviving task id when a node is recorded twice", async () => {
    // Regression: a re-review upserts the task, keeping the original row and id.
    // Returning the freshly generated id made every llm_calls insert fail its FK.
    const first = recorder.recordNode(reviewId, node());
    const second = recorder.recordNode(reviewId, node({ costCents: 9 }));

    expect(second).toBe(first);
    const rows = db
      .prepare("SELECT id, cost_cents FROM tasks WHERE review_id=?")
      .all<{ id: string; cost_cents: number }>(reviewId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cost_cents).toBe(9);
  });

  it("can attach llm_calls to a re-recorded task without violating the foreign key", () => {
    recorder.recordNode(reviewId, node());
    const taskId = recorder.recordNode(reviewId, node());

    expect(() =>
      recorder.recordLoop(reviewId, taskId, "ollama", "glm-5.3:cloud", {
        steps: [
          {
            index: 0,
            costCents: 1,
            toolResults: [],
            response: {
              text: "",
              toolCalls: [],
              finishReason: "stop",
              usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
              latencyMs: 50,
              model: "glm-5.3:cloud",
              providerId: "ollama",
            },
          },
        ],
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costCents: 1,
        stopKind: "terminal-tool",
        finalText: "",
        messages: [],
      }),
    ).not.toThrow();

    expect(db.prepare("SELECT COUNT(*) AS n FROM llm_calls").get<{ n: number }>()?.n).toBe(1);
  });

  it("replaces findings on a re-review instead of stacking duplicates", () => {
    recorder.recordFindings(reviewId, [finding()], []);
    recorder.recordOutcome(reviewId, {
      reviewId,
      state: "done",
      nodes: [node()],
      costCents: 1,
      durationMs: 1,
      allowedCommands: [],
      egressLog: [],
      triage: { posted: [finding()], suppressed: [], summary: "" },
    });

    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM findings WHERE review_id=?")
        .get<{ n: number }>(reviewId)?.n,
    ).toBe(1);
  });

  it("persists suppressed findings with their reason, for later measurement", () => {
    recorder.recordFindings(
      reviewId,
      [finding()],
      [finding({ title: "low", suppressedReason: "below threshold" })],
    );
    const rows = db
      .prepare("SELECT status, suppressed_reason FROM findings WHERE review_id=? ORDER BY status")
      .all<{ status: string; suppressed_reason: string | null }>(reviewId);

    expect(rows.map((r) => r.status)).toEqual(["open", "suppressed"]);
    expect(rows[1]?.suppressed_reason).toBe("below threshold");
  });
});

describe("environment records", () => {
  it("records a sandbox and then closes it", () => {
    // The table was read by the admin API and updated by reap while nothing ever
    // inserted a row, so the environments view was permanently empty and reap's "stale
    // rows closed" never fired. Containers were not leaking — the finalizer and the
    // label sweep both work — but there was no record to reconcile them against.
    recorder.recordEnvironment(reviewId, {
      id: "env-1",
      kind: "analyze",
      agentId: "security",
      containerId: "c1",
      imageId: "maestro/snapshot:x",
      ttlMs: 60_000,
      spec: { cpus: 2 },
    });

    const running = db
      .prepare("SELECT state, kind, agent_id, container_id FROM environments WHERE id=?")
      .get<{ state: string; kind: string; agent_id: string; container_id: string }>("env-1");
    expect(running).toMatchObject({
      state: "running",
      kind: "analyze",
      agent_id: "security",
      container_id: "c1",
    });

    recorder.closeEnvironment("env-1");
    const closed = db
      .prepare("SELECT state, destroyed_at FROM environments WHERE id=?")
      .get<{ state: string; destroyed_at: string | null }>("env-1");
    expect(closed?.state).toBe("destroyed");
    expect(closed?.destroyed_at).toBeTruthy();
  });

  it("marks a sandbox that would not destroy as leaked, not destroyed", () => {
    // The distinction is the whole point: "destroyed" and "we could not destroy it" must
    // not look the same to whoever is chasing disk usage.
    recorder.recordEnvironment(reviewId, {
      id: "env-2",
      kind: "prepare",
      ttlMs: 60_000,
      spec: {},
    });
    recorder.closeEnvironment("env-2", "leaked");
    const row = db
      .prepare("SELECT state FROM environments WHERE id=?")
      .get<{ state: string }>("env-2");
    expect(row?.state).toBe("leaked");
  });

  it("gives every row a lease and a ttl, which is what a later sweep reconciles against", () => {
    recorder.recordEnvironment(reviewId, { id: "env-3", kind: "prepare", ttlMs: 1000, spec: {} });
    const row = db
      .prepare("SELECT lease_until, ttl_at, created_at FROM environments WHERE id=?")
      .get<{ lease_until: string; ttl_at: string; created_at: string }>("env-3");
    expect(new Date(row!.ttl_at).getTime()).toBeGreaterThan(new Date(row!.created_at).getTime());
    expect(row?.lease_until).toBeTruthy();
  });
});
