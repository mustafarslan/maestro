import { inClause } from "./finding-status.js";
import { newId } from "./ids.js";
import { ACTIVE_TASK_STATES } from "./lifecycle.js";
import type { SqlDatabase } from "./store/driver.js";

export interface CreateReviewInput {
  repoOwner: string;
  repoName: string;
  prNumber: number;
  headSha: string;
  baseSha?: string;
  baseRef?: string;
  title?: string;
  author?: string;
  isFork?: boolean;
  playbookVersionId: string;
}

export interface ReviewRow {
  id: string;
  repo_id: string;
  pr_number: number;
  head_sha: string;
  state: string;
}

/**
 * Persistence for reviews.
 *
 * `(repo, pr, head_sha)` is unique, which is the idempotency key: it absorbs webhook
 * redelivery and the overlap between webhook and poll mode. Re-requesting an existing
 * review returns the existing row rather than starting a second one.
 */
export class ReviewStore {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * The repository row, created if it is not there.
   *
   * Insert-then-read rather than read-then-insert. `SELECT`, then `INSERT` if it missed,
   * is a check-then-act across two statements: with three workers plus a webhook and a
   * poller all touching the same repository, both can miss and both can insert, and the
   * loser hits `UNIQUE (owner, name)` and throws. `ON CONFLICT DO NOTHING` makes the
   * whole thing one atomic statement, and the loser reads the winner's row.
   */
  ensureRepo(owner: string, name: string): string {
    const id = newId("rv").replace("rv_", "repo_");
    const res = this.db
      .prepare(
        `INSERT INTO repos (id, owner, name, default_branch, enabled, created_at)
         VALUES (?,?,?,?,1,?)
         ON CONFLICT(owner, name) DO NOTHING`,
      )
      .run(id, owner, name, "main", new Date().toISOString());
    if (res.changes > 0) return id;

    const existing = this.db
      .prepare("SELECT id FROM repos WHERE owner=? AND name=?")
      .get<{ id: string }>(owner, name);
    if (!existing) throw new Error(`repo ${owner}/${name} vanished between insert and read`);
    return existing.id;
  }

  /**
   * Records the ticket this review was checked against.
   *
   * `reviews.linear_issue_json` was in the schema from the first migration and nothing
   * ever wrote it, so the acceptance criteria a product agent judged the diff by were
   * held only in the prompt and thrown away with it. "Why did it say that on PR 412?"
   * is the question the whole pinning design exists to answer, and this was the half of
   * the answer that was not being kept. Resolved after the row is created, because the
   * lookup is a network call the review must survive without.
   */
  setLinearIssue(reviewId: string, issue: unknown): void {
    this.db
      .prepare("UPDATE reviews SET linear_issue_json=? WHERE id=?")
      .run(issue === undefined || issue === null ? null : JSON.stringify(issue), reviewId);
  }

  /**
   * Returns the existing review when one already covers this exact head SHA.
   *
   * `unique(repo_id, pr_number, head_sha)` is the idempotency key the plan names, and it
   * covers webhook redelivery and the poller racing the webhook — but only if the code
   * around it is atomic. It was `SELECT`, then `INSERT` if the select missed, which is a
   * check-then-act across two statements with no transaction: two workers handling the
   * same pull request both miss, both insert, and the loser gets a constraint violation
   * that fails its job. The constraint was doing its job; the code above it was turning a
   * successful deduplication into an error.
   *
   * Insert first, with `ON CONFLICT DO NOTHING`, and read the winner's row when the
   * insert finds one. One statement decides, so there is no window. The id generated on
   * the losing path is simply discarded, which costs nothing.
   */
  create(input: CreateReviewInput): { id: string; created: boolean } {
    const repoId = this.ensureRepo(input.repoOwner, input.repoName);
    const id = newId("rv");
    const res = this.db
      .prepare(
        `INSERT INTO reviews (id, repo_id, pr_number, head_sha, base_sha, base_ref, title, author,
                              is_fork, trust, playbook_version_id, state, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,'queued',?)
         ON CONFLICT(repo_id, pr_number, head_sha) DO NOTHING`,
      )
      .run(
        id,
        repoId,
        input.prNumber,
        input.headSha,
        input.baseSha ?? null,
        input.baseRef ?? null,
        input.title ?? null,
        input.author ?? null,
        input.isFork ? 1 : 0,
        input.isFork ? "untrusted" : "trusted",
        input.playbookVersionId,
        new Date().toISOString(),
      );
    if (res.changes > 0) return { id, created: true };

    const existing = this.db
      .prepare("SELECT id FROM reviews WHERE repo_id=? AND pr_number=? AND head_sha=?")
      .get<{ id: string }>(repoId, input.prNumber, input.headSha);
    if (!existing) {
      throw new Error(
        `review for ${input.prNumber}@${input.headSha} vanished between insert and read`,
      );
    }
    return { id: existing.id, created: false };
  }

  setState(id: string, state: string, extra: { error?: string; costCents?: number } = {}): void {
    const terminal = ["done", "failed", "cancelled", "skipped", "superseded"].includes(state);
    this.db
      .prepare(
        `UPDATE reviews SET state=?, error=COALESCE(?, error), cost_cents=COALESCE(?, cost_cents),
                            started_at=COALESCE(started_at, ?), finished_at=?
         WHERE id=?`,
      )
      .run(
        state,
        extra.error ?? null,
        extra.costCents ?? null,
        new Date().toISOString(),
        terminal ? new Date().toISOString() : null,
        id,
      );
  }

  /**
   * Marks earlier reviews of the same PR superseded. Idempotency stops duplicate reviews
   * per SHA; this stops a review for a SHA a later push has already replaced from being
   * posted at all.
   */
  supersedeOlder(repoId: string, prNumber: number, currentHeadSha: string): number {
    const res = this.db
      .prepare(
        `UPDATE reviews SET state='superseded', finished_at=?
         WHERE repo_id=? AND pr_number=? AND head_sha<>?
           AND state NOT IN ('done','failed','cancelled','superseded')`,
      )
      .run(new Date().toISOString(), repoId, prNumber, currentHeadSha);
    return res.changes;
  }

  get(id: string): ReviewRow | undefined {
    return this.db.prepare("SELECT * FROM reviews WHERE id=?").get<ReviewRow>(id);
  }
}

/**
 * Every state a review can be in.
 *
 * Exported so nothing has to restate it. The UI missed two of these — `triaging` and
 * `cancelled` rendered with no colour at all, so a cancelled review looked like neither
 * finished nor failed, which is the state it most needs to be distinguishable in.
 */
export const REVIEW_STATES = [
  "queued",
  "preparing",
  "analyzing",
  "triaging",
  "posting",
  "done",
  "failed",
  "cancelled",
  "superseded",
] as const;

/** States in which a review is being worked on by somebody. */
export const IN_FLIGHT_STATES = [
  "queued",
  "preparing",
  "analyzing",
  "triaging",
  "posting",
] as const;

/**
 * States a review will never leave. Derived, not written out.
 *
 * A third copy of this list was hand-written in `pruneTelemetry` within an hour of a
 * finding about exactly this shape — a canonical list and a hand-maintained duplicate,
 * correct today and free to diverge the moment somebody adds a state. Deriving it means a
 * new state must be classified as in-flight or terminal, and cannot silently be neither.
 */
export const TERMINAL_STATES = REVIEW_STATES.filter(
  (s) => !(IN_FLIGHT_STATES as readonly string[]).includes(s),
);

/**
 * Fails reviews left mid-flight by a process that is no longer running.
 *
 * Nothing reset review state on a crash, so an interrupted review sat in `analyzing`
 * for ever. That was untidy on its own and became a leak once the reaper learned to skip
 * containers belonging to in-flight reviews: the orphan was protected permanently, and
 * its containers — the ones the reaper exists to collect after exactly this kind of
 * crash — could never be swept.
 *
 * `olderThanMs` must exceed the job lease, so a review a live worker is still holding is
 * never mistaken for an orphan.
 */
export function recoverStaleReviews(db: SqlDatabase, olderThanMs: number): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const placeholders = IN_FLIGHT_STATES.map(() => "?").join(",");
  const now = new Date().toISOString();

  return db.transaction(() => {
    const stale = db
      .prepare(
        `SELECT id FROM reviews
         WHERE state IN (${placeholders}) AND COALESCE(started_at, created_at) < ?`,
      )
      .all<{ id: string }>(...IN_FLIGHT_STATES, cutoff)
      .map((r) => r.id);
    if (!stale.length) return 0;

    const list = stale.map(() => "?").join(",");
    db.prepare(
      `UPDATE reviews SET state='failed', error=?, finished_at=? WHERE id IN (${list})`,
    ).run("interrupted: no worker was holding this review when the daemon started", now, ...stale);

    // The children have to move too. A failed review whose tasks still say "running"
    // is a contradiction on the board, and an environment row left `running` is a
    // sandbox the UI shows as live for ever and nothing ever reconciles.
    db.prepare(
      `UPDATE tasks SET state='failed', error=?, finished_at=?
       WHERE review_id IN (${list})
         AND state IN (${inClause(ACTIVE_TASK_STATES).sql})`,
    ).run("interrupted with its review", now, ...stale, ...inClause(ACTIVE_TASK_STATES).params);

    // 'leaked', not 'destroyed': whether the container actually went away is unknown,
    // and claiming it was cleaned up is the assertion that hides a disk filling.
    db.prepare(
      `UPDATE environments SET state='leaked', destroyed_at=?
       WHERE review_id IN (${list}) AND state NOT IN ('destroyed','leaked')`,
    ).run(now, ...stale);

    return stale.length;
  });
}

/**
 * Which of the given review ids belong to one pull request.
 *
 * A pure predicate rather than a loop inside the daemon, because the property it encodes
 * is a tenant boundary: matching on the pull request number alone let a `closed` event in
 * one repository abort reviews in another — including private repositories the sender
 * cannot read. That was fixed once, claimed, and not actually applied; the test guarding
 * it then asserted the SHAPE OF THE SOURCE rather than the behaviour, so it would have
 * passed on a filter that kept the same words and matched the wrong rows.
 *
 * Exported so the boundary can be exercised directly with two repositories and one
 * number, which is the only test that fails for every wrong implementation rather than
 * for one spelling of the wrong implementation.
 */
export function reviewsForPullRequest(
  db: SqlDatabase,
  candidateIds: Iterable<string>,
  pr: { repoId: string; number: number },
): string[] {
  const store = new ReviewStore(db);
  return [...candidateIds].filter((id) => {
    const meta = store.get(id);
    return meta?.repo_id === pr.repoId && meta.pr_number === pr.number;
  });
}

/**
 * Whether a review of this pull request is already queued or running.
 *
 * The queue's `dedupe_key` is `UNIQUE` across the whole table and rows are never pruned,
 * so it can only express "never enqueue this again" — which is right for a webhook
 * delivery id and wrong for a person asking. A request keyed on who asked (the comment
 * id, or the moment of an MCP call) is correctly enqueued a second time once the first
 * has finished; what it must not do is stack a second review on top of one still
 * running, which is wasted containers and money for a comment that gets updated in place
 * either way.
 *
 * Deliberately about jobs rather than reviews: a queued job has no review row yet.
 */
export function hasPendingReviewJob(
  db: SqlDatabase,
  pr: { owner: string; repo: string; number: number },
): boolean {
  const rows = db
    .prepare(
      "SELECT payload_json FROM jobs WHERE kind='review-pr' AND state IN ('queued','running')",
    )
    .all<{ payload_json: string }>();
  return rows.some((r) => {
    try {
      const p = JSON.parse(r.payload_json) as { owner?: string; repo?: string; number?: number };
      return p.owner === pr.owner && p.repo === pr.repo && p.number === pr.number;
    } catch {
      return false;
    }
  });
}
