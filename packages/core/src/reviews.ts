import { newId } from "./ids.js";
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

  ensureRepo(owner: string, name: string): string {
    const existing = this.db
      .prepare("SELECT id FROM repos WHERE owner=? AND name=?")
      .get<{ id: string }>(owner, name);
    if (existing) return existing.id;

    const id = newId("rv").replace("rv_", "repo_");
    this.db
      .prepare(
        "INSERT INTO repos (id, owner, name, default_branch, enabled, created_at) VALUES (?,?,?,?,1,?)",
      )
      .run(id, owner, name, "main", new Date().toISOString());
    return id;
  }

  /** Returns the existing review when one already covers this exact head SHA. */
  create(input: CreateReviewInput): { id: string; created: boolean } {
    const repoId = this.ensureRepo(input.repoOwner, input.repoName);
    const existing = this.db
      .prepare("SELECT id FROM reviews WHERE repo_id=? AND pr_number=? AND head_sha=?")
      .get<{ id: string }>(repoId, input.prNumber, input.headSha);
    if (existing) return { id: existing.id, created: false };

    const id = newId("rv");
    this.db
      .prepare(
        `INSERT INTO reviews (id, repo_id, pr_number, head_sha, base_sha, base_ref, title, author,
                              is_fork, trust, playbook_version_id, state, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,'queued',?)`,
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
    return { id, created: true };
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
       WHERE review_id IN (${list}) AND state IN ('pending','ready','running')`,
    ).run("interrupted with its review", now, ...stale);

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
