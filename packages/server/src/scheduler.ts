import { logger } from "@maestro/core";

export interface SchedulerLimits {
  /** Total agent tasks running at once across every review. */
  global: number;
  /** Per agent id, so one slow specialist cannot monopolise the pool. */
  perAgent: number;
  /** Per repository, so one busy repo cannot starve the others. */
  perRepo: number;
  /** Per provider, to stay under rate limits. */
  perProvider: number;
}

export const DEFAULT_LIMITS: SchedulerLimits = {
  global: 6,
  perAgent: 2,
  perRepo: 3,
  perProvider: 4,
};

export interface SlotRequest {
  reviewId: string;
  agentId: string;
  repoId: string;
  providerId: string;
}

/**
 * Concurrency control across concurrent reviews.
 *
 * This is what delivers the core requirement: while the product agent is saturated on
 * PR #1, the other agents flow to PR #2 instead of queueing behind it. Admission is
 * round-robin **across reviews** rather than FIFO, so a large pull request cannot
 * starve a small one that arrived later.
 */
export class Scheduler {
  private readonly running = new Map<string, SlotRequest>();
  private readonly waiters: {
    req: SlotRequest;
    resolve: (release: () => void) => void;
    seq: number;
  }[] = [];
  private seq = 0;
  /** Reviews that most recently got a slot, so admission can rotate past them. */
  private recentReviews: string[] = [];

  constructor(private readonly limits: SchedulerLimits = DEFAULT_LIMITS) {}

  stats(): { running: number; waiting: number; byAgent: Record<string, number> } {
    const byAgent: Record<string, number> = {};
    for (const r of this.running.values()) byAgent[r.agentId] = (byAgent[r.agentId] ?? 0) + 1;
    return { running: this.running.size, waiting: this.waiters.length, byAgent };
  }

  private count(pred: (r: SlotRequest) => boolean): number {
    let n = 0;
    for (const r of this.running.values()) if (pred(r)) n++;
    return n;
  }

  private admissible(req: SlotRequest): boolean {
    if (this.running.size >= this.limits.global) return false;
    if (this.count((r) => r.agentId === req.agentId) >= this.limits.perAgent) return false;
    if (this.count((r) => r.repoId === req.repoId) >= this.limits.perRepo) return false;
    if (this.count((r) => r.providerId === req.providerId) >= this.limits.perProvider) return false;
    return true;
  }

  /** Resolves with a release function once a slot is free. */
  acquire(req: SlotRequest): Promise<() => void> {
    return new Promise((resolve) => {
      this.waiters.push({ req, resolve, seq: this.seq++ });
      this.pump();
    });
  }

  private pump(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const candidates = this.waiters.filter((w) => this.admissible(w.req));
      if (!candidates.length) return;

      // Fairness: prefer a review that has not recently been admitted. FIFO alone lets
      // a 40-file pull request occupy every slot while a 2-file one waits behind it.
      const fresh = candidates.filter((c) => !this.recentReviews.includes(c.req.reviewId));
      const chosen = (fresh.length ? fresh : candidates).sort((a, b) => a.seq - b.seq)[0];
      if (!chosen) return;

      this.waiters.splice(this.waiters.indexOf(chosen), 1);
      const key = `${chosen.req.reviewId}:${chosen.req.agentId}:${chosen.seq}`;
      this.running.set(key, chosen.req);

      this.recentReviews = [
        chosen.req.reviewId,
        ...this.recentReviews.filter((r) => r !== chosen.req.reviewId),
      ].slice(0, Math.max(1, this.limits.global));

      let released = false;
      chosen.resolve(() => {
        if (released) return;
        released = true;
        this.running.delete(key);
        this.pump();
      });
      progressed = true;
    }
  }
}
