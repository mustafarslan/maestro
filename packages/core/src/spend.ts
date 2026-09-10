import { TERMINAL_STATES } from "./reviews.js";
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

/**
 * Deletes the bulky per-step telemetry of old reviews.
 *
 * Nothing in this system has ever deleted anything. Every table grows for the life of the
 * install — at a hundred reviews a day that is roughly four and a half million rows a
 * year, dominated by `spans` and `llm_calls`, which are one row per model step and are
 * worth reading for about as long as somebody is still asking why a particular review said
 * what it said.
 *
 * `trajectory_turns` joins the sweep for the same reason and more so: it is one row per
 * turn of every agent run, carrying the prompts and every tool result verbatim, which
 * makes it the largest of the three by a wide margin. Exempting it would have quietly
 * turned the one table that stores repository text into the one table nothing deletes.
 *
 * Deliberately narrow. `reviews` and `findings` stay for ever, because they carry the
 * accepted/dismissed history the whole quality loop is measured from and they are small.
 * `jobs` stays because its `dedupe_key` is the idempotency record: deleting a row would let
 * a redelivered webhook start a second review of the same head SHA, years later. What goes
 * is the step-by-step trace, which is the bulk and the part nobody reads after the fact.
 */
export function pruneTelemetry(
  db: SqlDatabase,
  olderThanMs: number,
): { spans: number; llmCalls: number; trajectoryTurns: number } {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const old = db
    .prepare(
      `SELECT id FROM reviews
        WHERE state IN (${TERMINAL_STATES.map(() => "?").join(",")})
          AND COALESCE(finished_at, created_at) < ?`,
    )
    .all<{ id: string }>(...TERMINAL_STATES, cutoff);
  if (!old.length) return { spans: 0, llmCalls: 0, trajectoryTurns: 0 };

  return db.transaction(() => {
    let spans = 0;
    let llmCalls = 0;
    let trajectoryTurns = 0;
    for (const { id } of old) {
      spans += db.prepare("DELETE FROM spans WHERE review_id=?").run(id).changes;
      llmCalls += db.prepare("DELETE FROM llm_calls WHERE review_id=?").run(id).changes;
      trajectoryTurns += db
        .prepare("DELETE FROM trajectory_turns WHERE review_id=?")
        .run(id).changes;
    }
    return { spans, llmCalls, trajectoryTurns };
  });
}
