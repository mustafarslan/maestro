import { beforeEach, describe, expect, it } from "vitest";
import { ReviewStore } from "./reviews.js";
import { SpanRecorder } from "./spans.js";
import { openStore } from "./store/db.js";
import type { SqlDatabase } from "./store/driver.js";

let db: SqlDatabase;
let recorder: SpanRecorder;
let reviewId: string;

beforeEach(async () => {
  db = await openStore({ path: ":memory:" });
  db.prepare(
    `INSERT INTO playbooks (id, name, created_at, updated_at)
     VALUES ('pb', 'default', datetime('now'), datetime('now'))`,
  ).run();
  db.prepare(
    `INSERT INTO playbook_versions (id, playbook_id, version, schema_version, document, created_at)
     VALUES ('pv', 'pb', 1, 1, '{}', datetime('now'))`,
  ).run();
  reviewId = new ReviewStore(db).create({
    repoOwner: "acme",
    repoName: "web",
    prNumber: 1,
    headSha: "a".repeat(40),
    playbookVersionId: "pv",
  }).id;
  recorder = new SpanRecorder(db);
});

const spanRow = (id: string) =>
  db
    .prepare("SELECT status, started_at, ended_at, duration_ms, attrs_json FROM spans WHERE id=?")
    .get<{
      status: string;
      started_at: string;
      ended_at: string | null;
      duration_ms: number | null;
      attrs_json: string | null;
    }>(id);

describe("SpanRecorder", () => {
  it("records a span that has started but not finished", () => {
    // The live board reads these mid-review: an open span is how "this is running now"
    // is distinguished from "this finished".
    const id = recorder.start("prepare-env", { reviewId });
    const row = spanRow(id);
    expect(row?.started_at).toBeTruthy();
    expect(row?.ended_at).toBeNull();
    expect(row?.duration_ms).toBeNull();
  });

  it("closes the span when the work throws, and records why", async () => {
    // The whole point of the wrapper. A span left open by a failure shows in the
    // waterfall as work still running, on a review that died minutes ago.
    await expect(
      recorder.span("agent", { reviewId }, async () => {
        throw new Error("docker daemon unreachable");
      }),
    ).rejects.toThrow("docker daemon unreachable");

    const [row] = db
      .prepare("SELECT status, ended_at, attrs_json FROM spans WHERE name='agent'")
      .all<{ status: string; ended_at: string | null; attrs_json: string | null }>();
    expect(row?.status).toBe("error");
    expect(row?.ended_at).toBeTruthy();
    expect(row?.attrs_json).toContain("docker daemon unreachable");
  });

  it("closes the span and returns the value on the happy path", async () => {
    const out = await recorder.span("triage", { reviewId }, async () => "done");
    expect(out).toBe("done");
    const [row] = db
      .prepare("SELECT status, ended_at FROM spans WHERE name='triage'")
      .all<{ status: string; ended_at: string | null }>();
    expect(row?.status).toBe("ok");
    expect(row?.ended_at).toBeTruthy();
  });

  it("merges attributes added at the end with those set at the start", () => {
    const id = recorder.start("agent", { reviewId }, { agentId: "security" });
    recorder.end(id, "ok", { findings: 3 });
    const attrs = JSON.parse(spanRow(id)?.attrs_json ?? "{}");
    // Losing the start attributes would strip the agent id off every finished span.
    expect(attrs).toMatchObject({ agentId: "security", findings: 3 });
  });

  it("records a non-negative duration", () => {
    const id = recorder.start("router", { reviewId });
    recorder.end(id);
    expect(spanRow(id)?.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("ignores ending a span that does not exist", () => {
    // Teardown runs on every terminal path, including ones where the span was never
    // opened; throwing there would replace a real error with a bogus one.
    expect(() => recorder.end("sp_never_created")).not.toThrow();
  });

  it("keeps the parent link that makes the waterfall a tree", () => {
    const parent = recorder.start("review", { reviewId });
    const child = recorder.start("agent", { reviewId, parentId: parent });
    const row = db
      .prepare("SELECT parent_id FROM spans WHERE id=?")
      .get<{ parent_id: string | null }>(child);
    expect(row?.parent_id).toBe(parent);
  });
});
