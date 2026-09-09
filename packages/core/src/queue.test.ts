import { beforeEach, describe, expect, it } from "vitest";
import { JobQueue } from "./queue.js";
import { openStore } from "./store/db.js";
import type { SqlDatabase } from "./store/driver.js";

let db: SqlDatabase;

beforeEach(async () => {
  db = await openStore({ path: ":memory:" });
});

describe("JobQueue", () => {
  it("enqueues and claims in FIFO order within a priority", () => {
    const q = new JobQueue(db, "w1");
    q.enqueue({ kind: "review", payload: { pr: 1 } });
    q.enqueue({ kind: "review", payload: { pr: 2 } });

    expect(q.claim()?.payload).toEqual({ pr: 1 });
    expect(q.claim()?.payload).toEqual({ pr: 2 });
    expect(q.claim()).toBeNull();
  });

  it("honours priority over insertion order", () => {
    const q = new JobQueue(db, "w1");
    q.enqueue({ kind: "review", payload: { pr: 1 }, priority: 0 });
    q.enqueue({ kind: "review", payload: { pr: 2 }, priority: 10 });
    expect(q.claim()?.payload).toEqual({ pr: 2 });
  });

  it("collapses duplicates by dedupe key: redelivered webhooks must not double-review", () => {
    const q = new JobQueue(db, "w1");
    const first = q.enqueue({ kind: "review", payload: { sha: "abc" }, dedupeKey: "repo#1@abc" });
    const second = q.enqueue({ kind: "review", payload: { sha: "abc" }, dedupeKey: "repo#1@abc" });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(q.claim()).not.toBeNull();
    expect(q.claim()).toBeNull();
  });

  it("does not hand the same job to a second worker while the lease holds", () => {
    const a = new JobQueue(db, "w1");
    const b = new JobQueue(db, "w2");
    a.enqueue({ kind: "review", payload: {} });

    expect(a.claim(60_000)).not.toBeNull();
    expect(b.claim(60_000)).toBeNull();
  });

  it("reclaims a job whose lease expired: this is the crash-recovery path", () => {
    const a = new JobQueue(db, "w1");
    const b = new JobQueue(db, "w2");
    a.enqueue({ kind: "review", payload: {} });

    const claimed = a.claim(-1_000); // already-expired lease stands in for a dead worker
    expect(claimed).not.toBeNull();

    const reclaimed = b.claim(60_000);
    expect(reclaimed?.id).toBe(claimed?.id);
    expect(reclaimed?.attempts).toBe(2);
  });

  it("filters by kind so a worker pool can specialise", () => {
    const q = new JobQueue(db, "w1");
    q.enqueue({ kind: "prepare", payload: { a: 1 } });
    q.enqueue({ kind: "agent", payload: { b: 2 } });

    expect(q.claim(60_000, ["agent"])?.payload).toEqual({ b: 2 });
  });

  it("retries with backoff until max attempts, then fails permanently", () => {
    const q = new JobQueue(db, "w1");
    q.enqueue({ kind: "review", payload: {}, maxAttempts: 2 });

    const job = q.claim();
    q.fail(job!.id, "boom", 0);
    expect(q.stats().queued).toBe(1);

    const retry = q.claim();
    expect(retry?.attempts).toBe(2);
    q.fail(retry!.id, "boom again", 0);
    expect(q.stats().failed).toBe(1);
    expect(q.claim()).toBeNull();
  });

  it("extends a lease via heartbeat so long tasks are not stolen", () => {
    const a = new JobQueue(db, "w1");
    const b = new JobQueue(db, "w2");
    a.enqueue({ kind: "review", payload: {} });
    const job = a.claim(-1_000);

    a.heartbeat(job!.id, 60_000);
    expect(b.claim()).toBeNull();
  });

  it("marks completed jobs done", () => {
    const q = new JobQueue(db, "w1");
    q.enqueue({ kind: "review", payload: {} });
    const job = q.claim();
    q.complete(job!.id);
    expect(q.stats().done).toBe(1);
    expect(q.claim()).toBeNull();
  });
});

describe("leases on work that outlives them", () => {
  it("lets another worker claim a job whose lease expired", async () => {
    // This is the crash-recovery behaviour and it must keep working: a worker that dies
    // holds its job only until the lease runs out.
    const a = new JobQueue(db, "worker-a");
    const b = new JobQueue(db, "worker-b");
    a.enqueue({ kind: "review-pr", payload: { n: 1 } });

    const first = a.claim(-1); // already expired
    expect(first).toBeTruthy();
    expect(b.claim(60_000)).toBeTruthy();
  });

  it("keeps a job claimed while its holder renews", async () => {
    // Reviews routinely approach the lease. Without renewal a long one is re-claimed,
    // burns an attempt each time, and is eventually marked failed while still
    // succeeding. `heartbeat` existed for this and the daemon never called it.
    const a = new JobQueue(db, "worker-a");
    const b = new JobQueue(db, "worker-b");
    a.enqueue({ kind: "review-pr", payload: { n: 1 } });

    const job = a.claim(-1);
    expect(job).toBeTruthy();
    a.heartbeat(job!.id, 60_000);

    expect(b.claim(60_000), "a renewed job was stolen").toBeNull();
  });

  it("refuses to renew a job held by someone else", async () => {
    // Otherwise a worker could hold open a job it does not own, defeating recovery.
    const a = new JobQueue(db, "worker-a");
    const b = new JobQueue(db, "worker-b");
    a.enqueue({ kind: "review-pr", payload: { n: 1 } });

    const job = a.claim(-1);
    b.heartbeat(job!.id, 60_000);
    // Still claimable, because b's renewal did not apply to a's job.
    expect(b.claim(60_000)).toBeTruthy();
  });
});
