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
