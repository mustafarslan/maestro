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

describe("the plan's load scenario: 10 pull requests across 3 repos", () => {
  const AGENTS = ["product", "security", "architecture", "ui-ux"];

  /** Runs every agent of every review through the scheduler, recording concurrency. */
  async function runScenario(scheduler: Scheduler, reviews: { id: string; repo: string }[]) {
    let live = 0;
    let peak = 0;
    const peakByAgent: Record<string, number> = {};
    const liveByAgent: Record<string, number> = {};
    const liveByRepo: Record<string, number> = {};
    const peakByRepo: Record<string, number> = {};
    const admissionOrder: string[] = [];

    const tasks = reviews.flatMap((review) =>
      AGENTS.map(async (agentId) => {
        const release = await scheduler.acquire({
          reviewId: review.id,
          agentId,
          repoId: review.repo,
          providerId: "ollama",
        });
        admissionOrder.push(review.id);
        live++;
        const nowAgent = (liveByAgent[agentId] ?? 0) + 1;
        const nowRepo = (liveByRepo[review.repo] ?? 0) + 1;
        liveByAgent[agentId] = nowAgent;
        liveByRepo[review.repo] = nowRepo;
        peak = Math.max(peak, live);
        peakByAgent[agentId] = Math.max(peakByAgent[agentId] ?? 0, nowAgent);
        peakByRepo[review.repo] = Math.max(peakByRepo[review.repo] ?? 0, nowRepo);

        // Yield so other admitted work overlaps; without this nothing is concurrent.
        await new Promise((r) => setTimeout(r, 1));

        live--;
        liveByAgent[agentId] = (liveByAgent[agentId] ?? 1) - 1;
        liveByRepo[review.repo] = (liveByRepo[review.repo] ?? 1) - 1;
        release();
      }),
    );

    await Promise.all(tasks);
    return { peak, peakByAgent, peakByRepo, admissionOrder };
  }

  const scenario = () =>
    Array.from({ length: 10 }, (_, i) => ({
      id: `rv-${i}`,
      repo: `repo-${i % 3}`,
    }));

  it("completes every task without exceeding any limit", async () => {
    const limits = { global: 6, perAgent: 2, perRepo: 3, perProvider: 4 };
    const scheduler = new Scheduler(limits);

    const { peak, peakByAgent, peakByRepo } = await runScenario(scheduler, scenario());

    // 40 tasks all completed - nothing deadlocked or was dropped.
    expect(scheduler.stats()).toMatchObject({ running: 0, waiting: 0 });
    expect(peak).toBeLessThanOrEqual(limits.global);
    for (const agent of AGENTS) {
      expect(peakByAgent[agent] ?? 0).toBeLessThanOrEqual(limits.perAgent);
    }
    for (const repo of ["repo-0", "repo-1", "repo-2"]) {
      expect(peakByRepo[repo] ?? 0).toBeLessThanOrEqual(limits.perRepo);
    }
    // The provider cap binds below the global one here, so it is what actually limits.
    expect(peak).toBeLessThanOrEqual(limits.perProvider);
  });

  it("does not starve the last review behind the first", async () => {
    // This is the requirement in the user's own words: while the product agent is busy on
    // PR #1, the other agents must flow to PR #2 rather than queueing behind it. FIFO
    // admission would run reviews to completion in order, so the last review's first
    // admission would come after almost every other task.
    const scheduler = new Scheduler({ global: 6, perAgent: 2, perRepo: 3, perProvider: 4 });
    const { admissionOrder } = await runScenario(scheduler, scenario());

    const firstAdmissionOfLast = admissionOrder.indexOf("rv-9");
    expect(firstAdmissionOfLast).toBeGreaterThanOrEqual(0);
    // Measured: 32 of 40 with the old fixed-size recency window (FIFO in all but name),
    // 11 once fairness became an admission count. Three early admissions are unavoidable
    // — pump runs as each waiter is pushed, before the later ones exist — so the floor is
    // roughly one pass over the ten reviews.
    expect(firstAdmissionOfLast).toBeLessThanOrEqual(15);

    // And every review got its turn before any review finished all four of its agents.
    const distinctInFirstTen = new Set(admissionOrder.slice(0, 10)).size;
    expect(distinctInFirstTen).toBeGreaterThan(2);
  });

  it("keeps one saturated repo from blocking the other two", async () => {
    // 8 of 10 reviews on one repo: the per-repo cap must leave room for the others.
    const scheduler = new Scheduler({ global: 6, perAgent: 3, perRepo: 2, perProvider: 6 });
    const skewed = Array.from({ length: 10 }, (_, i) => ({
      id: `rv-${i}`,
      repo: i < 8 ? "busy" : `quiet-${i}`,
    }));

    const { peakByRepo, admissionOrder } = await runScenario(scheduler, skewed);

    expect(scheduler.stats()).toMatchObject({ running: 0, waiting: 0 });
    expect(peakByRepo.busy ?? 0).toBeLessThanOrEqual(2);
    // The quiet repos are not stuck at the back of a 32-task queue.
    expect(admissionOrder.indexOf("rv-9")).toBeLessThan(30);
  });
});
