import type { SqlDatabase } from "./store/driver.js";

/**
 * What has been spent recently, in cents.
 *
 * The plan lists per-task, per-review, per-repo and daily budget caps as the control on
 * cost blowup. The first two existed — a router tier caps a review, a model binding caps
 * an agent — and the two that bound *aggregate* spend did not, so nothing stopped a busy
 * repository, or a stuck retry loop across many reviews, from spending without limit. A
 * per-review cap cannot see that; only a rolling total can.
 *
 * Read from `llm_calls`, which records every call with its cost, rather than from
 * `reviews.cost_cents`: a review still running has spent money that has not been rolled
 * up yet, and that is exactly the money a cap needs to see.
 */
export function spendSince(
  db: SqlDatabase,
  sinceIso: string,
  opts: { repoId?: string } = {},
): number {
  const row = opts.repoId
    ? db
        .prepare(
          `SELECT COALESCE(SUM(c.cost_cents), 0) AS cents FROM llm_calls c
             JOIN reviews r ON r.id = c.review_id
            WHERE c.created_at >= ? AND r.repo_id = ?`,
        )
        .get<{ cents: number }>(sinceIso, opts.repoId)
    : db
        .prepare(
          "SELECT COALESCE(SUM(cost_cents), 0) AS cents FROM llm_calls WHERE created_at >= ?",
        )
        .get<{ cents: number }>(sinceIso);
  return row?.cents ?? 0;
}

/** The 24-hour window every cap in this file is measured over. */
export function dayAgo(now = Date.now()): string {
  return new Date(now - 24 * 60 * 60 * 1000).toISOString();
}

export interface SpendCaps {
  /** Everything Maestro spends, across every repository. */
  dailyCapCents?: number;
  /** Per repository, so one busy repo cannot consume the whole allowance. */
  perRepoDailyCapCents?: number;
}

export interface SpendVerdict {
  allowed: boolean;
  /** Present when refused: which cap, and where the total stands against it. */
  reason?: string;
  spentCents: number;
  repoSpentCents: number;
}

/**
 * Whether another review may start.
 *
 * Deliberately advisory rather than an exception: the caller decides whether to skip a
 * trigger, refuse a job or just log. A cap that threw would turn a budget decision into
 * a failed review, which reads to whoever sees it as Maestro being broken.
 */
export function checkSpend(
  db: SqlDatabase,
  caps: SpendCaps,
  opts: { repoId?: string; now?: number } = {},
): SpendVerdict {
  const since = dayAgo(opts.now);
  const spentCents = spendSince(db, since);
  const repoSpentCents = opts.repoId ? spendSince(db, since, { repoId: opts.repoId }) : 0;

  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  if (caps.dailyCapCents !== undefined && spentCents >= caps.dailyCapCents) {
    return {
      allowed: false,
      reason: `daily cap reached: ${money(spentCents)} spent in the last 24h, cap ${money(caps.dailyCapCents)}`,
      spentCents,
      repoSpentCents,
    };
  }
  if (
    opts.repoId &&
    caps.perRepoDailyCapCents !== undefined &&
    repoSpentCents >= caps.perRepoDailyCapCents
  ) {
    return {
      allowed: false,
      reason: `per-repository daily cap reached: ${money(repoSpentCents)} spent in the last 24h, cap ${money(caps.perRepoDailyCapCents)}`,
      spentCents,
      repoSpentCents,
    };
  }
  return { allowed: true, spentCents, repoSpentCents };
}
