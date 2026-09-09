import { describe, expect, it } from "vitest";
import { Scheduler } from "./scheduler.js";

const req = (reviewId: string, agentId: string, repoId = "r1", providerId = "anthropic") => ({
  reviewId,
  agentId,
  repoId,
  providerId,
});

describe("Scheduler", () => {
  it("admits up to the global limit and queues the rest", async () => {
    const s = new Scheduler({ global: 2, perAgent: 9, perRepo: 9, perProvider: 9 });
    await s.acquire(req("rv1", "a"));
    await s.acquire(req("rv1", "b"));

    let third = false;
    void s.acquire(req("rv1", "c")).then(() => {
      third = true;
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(third).toBe(false);
    expect(s.stats().running).toBe(2);
    expect(s.stats().waiting).toBe(1);
  });

  it("releases a slot to the next waiter", async () => {
    const s = new Scheduler({ global: 1, perAgent: 9, perRepo: 9, perProvider: 9 });
    const release = await s.acquire(req("rv1", "a"));

    let admitted = false;
    const pending = s.acquire(req("rv1", "b")).then((r) => {
      admitted = true;
      return r;
    });
    expect(admitted).toBe(false);

    release();
    await pending;
    expect(admitted).toBe(true);
  });

  it("caps concurrency per agent so one specialist cannot monopolise the pool", async () => {
    const s = new Scheduler({ global: 10, perAgent: 1, perRepo: 9, perProvider: 9 });
    await s.acquire(req("rv1", "security"));

    let second = false;
    void s.acquire(req("rv2", "security")).then(() => {
      second = true;
    });
    // A different agent on the same review is still free to run.
    await s.acquire(req("rv1", "product"));
    await new Promise((r) => setTimeout(r, 5));

    expect(second).toBe(false);
    expect(s.stats().running).toBe(2);
  });

  it("lets other agents flow to a second pull request while one agent is busy", async () => {
    // The core requirement: product saturated on PR#1 must not block security on PR#2.
    const s = new Scheduler({ global: 4, perAgent: 1, perRepo: 9, perProvider: 9 });
    await s.acquire(req("rv1", "product"));

    const started: string[] = [];
    await Promise.all(
      [
        ["rv2", "security"],
        ["rv2", "architecture"],
      ].map(async ([rv, agent]) => {
        await s.acquire(req(rv as string, agent as string));
        started.push(`${rv}:${agent}`);
      }),
    );

    expect(started.sort()).toEqual(["rv2:architecture", "rv2:security"]);
  });

  it("caps per repository so one busy repo cannot starve another", async () => {
    const s = new Scheduler({ global: 10, perAgent: 9, perRepo: 1, perProvider: 9 });
    await s.acquire(req("rv1", "a", "repoA"));

    let blocked = false;
    void s.acquire(req("rv2", "b", "repoA")).then(() => {
      blocked = true;
    });
    await s.acquire(req("rv3", "c", "repoB"));
    await new Promise((r) => setTimeout(r, 5));

    expect(blocked).toBe(false);
    expect(s.stats().running).toBe(2);
  });

  it("caps per provider to respect rate limits", async () => {
    const s = new Scheduler({ global: 10, perAgent: 9, perRepo: 9, perProvider: 1 });
    await s.acquire(req("rv1", "a", "r1", "anthropic"));

    let blocked = false;
    void s.acquire(req("rv2", "b", "r1", "anthropic")).then(() => {
      blocked = true;
    });
    await s.acquire(req("rv3", "c", "r1", "ollama"));
    await new Promise((r) => setTimeout(r, 5));

    expect(blocked).toBe(false);
  });

  it("does not let a large review starve one that arrived later", async () => {
    // Round-robin across reviews rather than FIFO: with one slot free, the review that
    // has not just run should get it.
    const s = new Scheduler({ global: 1, perAgent: 9, perRepo: 9, perProvider: 9 });
    const first = await s.acquire(req("big", "a"));

    const order: string[] = [];
    const p1 = s.acquire(req("big", "b")).then((r) => {
      order.push("big");
      return r;
    });
    const p2 = s.acquire(req("small", "a")).then((r) => {
      order.push("small");
      return r;
    });

    first();
    const r1 = await Promise.race([p1, p2]);
    r1();
    await Promise.all([p1, p2]);

    expect(order[0]).toBe("small");
  });

  it("ignores a double release rather than corrupting the slot count", async () => {
    const s = new Scheduler({ global: 1, perAgent: 9, perRepo: 9, perProvider: 9 });
    const release = await s.acquire(req("rv1", "a"));
    release();
    release();
    expect(s.stats().running).toBe(0);
  });
});

describe("cancellation", () => {
  it("removes a waiter for an aborted review instead of admitting it later", async () => {
    // A superseded review otherwise keeps its place in the fairness order and is
    // eventually admitted just to start a container it immediately abandons — so a dead
    // review goes on displacing live work until the queue drains.
    const scheduler = new Scheduler({ global: 1, perAgent: 1, perRepo: 1, perProvider: 1 });
    const held = await scheduler.acquire({
      reviewId: "rv-1",
      agentId: "security",
      repoId: "repo-1",
      providerId: "anthropic",
    });

    const controller = new AbortController();
    const queued = scheduler.acquire(
      { reviewId: "rv-2", agentId: "security", repoId: "repo-1", providerId: "anthropic" },
      controller.signal,
    );
    expect(scheduler.stats().waiting).toBe(1);

    controller.abort();
    await expect(queued).rejects.toThrow(/aborted/);
    expect(scheduler.stats().waiting).toBe(0);

    // The live slot is untouched, and releasing it admits nothing that was cancelled.
    held();
    expect(scheduler.stats().running).toBe(0);
  });

  it("refuses immediately when the signal is already aborted", async () => {
    const scheduler = new Scheduler();
    const controller = new AbortController();
    controller.abort();
    await expect(
      scheduler.acquire(
        { reviewId: "rv-1", agentId: "security", repoId: "repo-1", providerId: "anthropic" },
        controller.signal,
      ),
    ).rejects.toThrow(/aborted/);
    expect(scheduler.stats().waiting).toBe(0);
  });

  it("does not cancel a request that has already been admitted", async () => {
    // Once admitted the caller owns the release; yanking it from under them would double
    // count the slot.
    const scheduler = new Scheduler();
    const controller = new AbortController();
    const release = await scheduler.acquire(
      { reviewId: "rv-1", agentId: "security", repoId: "repo-1", providerId: "anthropic" },
      controller.signal,
    );
    controller.abort();
    expect(scheduler.stats().running).toBe(1);
    release();
    expect(scheduler.stats().running).toBe(0);
  });
});
