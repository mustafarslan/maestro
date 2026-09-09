import type { SqlDatabase } from "./store/driver.js";

/**
 * Incremental review.
 *
 * When a pull request is pushed to repeatedly, re-reviewing the whole diff every time is
 * expensive and — worse — repetitive: reviewers see the same comments again and stop
 * reading them. Scoping to the delta since the last reviewed SHA keeps each round cheap
 * and new, while findings that were reported and never addressed are carried forward so
 * nothing quietly disappears between pushes.
 */

export interface PreviousReview {
  reviewId: string;
  headSha: string;
  finishedAt: string | null;
}

export interface CarriedFinding {
  file: string | null;
  lineStart: number | null;
  category: string;
  severity: string;
  title: string;
  agentIds: string;
}

/** The most recent completed review of this PR at a different head SHA. */
export function previousReview(
  db: SqlDatabase,
  repoId: string,
  prNumber: number,
  currentHeadSha: string,
): PreviousReview | null {
  const row = db
    .prepare(
      `SELECT id, head_sha, finished_at FROM reviews
       WHERE repo_id=? AND pr_number=? AND head_sha<>? AND state='done'
       ORDER BY finished_at DESC LIMIT 1`,
    )
    .get<{ id: string; head_sha: string; finished_at: string | null }>(
      repoId,
      prNumber,
      currentHeadSha,
    );

  return row ? { reviewId: row.id, headSha: row.head_sha, finishedAt: row.finished_at } : null;
}

/**
 * Findings from the previous round that were shown and neither dismissed nor accepted.
 *
 * Both 'open' and 'posted' count: posting stamps a finding 'posted', so selecting only
 * 'open' silently matched nothing on every real review.
 *
 * Deliberately excludes suppressed ones: something below the reporting threshold last
 * time should not be resurrected simply because the author pushed again.
 */
export function unresolvedFindings(db: SqlDatabase, reviewId: string): CarriedFinding[] {
  return db
    .prepare(
      `SELECT file, line_start AS lineStart, category, severity, title, agent_id AS agentIds
       FROM findings
       WHERE review_id=? AND status IN ('open','posted')
       ORDER BY severity, confidence DESC`,
    )
    .all<CarriedFinding>(reviewId);
}

export interface IncrementalPlan {
  /** Ref to diff against: the previous reviewed SHA, or the PR base on a first review. */
  baseRef: string;
  incremental: boolean;
  previousHeadSha?: string;
  carried: CarriedFinding[];
}

/**
 * Decides whether this round can be incremental.
 *
 * Falls back to a full review whenever the previous state is not usable, because a
 * partial review presented as a complete one is worse than paying for the full diff.
 */
export function planIncremental(
  db: SqlDatabase,
  opts: {
    repoId: string;
    prNumber: number;
    headSha: string;
    baseSha: string;
    /** Set false to force a full review (a playbook change invalidates the comparison). */
    allowIncremental?: boolean;
  },
): IncrementalPlan {
  if (opts.allowIncremental === false) {
    return { baseRef: opts.baseSha, incremental: false, carried: [] };
  }

  const previous = previousReview(db, opts.repoId, opts.prNumber, opts.headSha);
  if (!previous) return { baseRef: opts.baseSha, incremental: false, carried: [] };

  return {
    baseRef: previous.headSha,
    incremental: true,
    previousHeadSha: previous.headSha,
    carried: unresolvedFindings(db, previous.reviewId),
  };
}
