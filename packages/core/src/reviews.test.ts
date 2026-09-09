import { beforeEach, describe, expect, it } from "vitest";
import {
  IN_FLIGHT_STATES,
  ReviewStore,
  recoverStaleReviews,
  reviewsForPullRequest,
} from "./reviews.js";
import { openStore } from "./store/db.js";
import type { SqlDatabase } from "./store/driver.js";

let db: SqlDatabase;
let store: ReviewStore;

beforeEach(async () => {
  db = await openStore({ path: ":memory:" });
  db.prepare(
    `INSERT INTO playbooks (id, name, created_at, updated_at)
     VALUES ('pb','default',datetime('now'),datetime('now'))`,
  ).run();
  db.prepare(
    `INSERT INTO playbook_versions (id, playbook_id, version, schema_version, document, created_at)
     VALUES ('pv','pb',1,1,'{}',datetime('now'))`,
  ).run();
  store = new ReviewStore(db);
});

const makeReview = (n: number, state: string, ageMs: number) => {
  const { id } = store.create({
    repoOwner: "acme",
    repoName: "web",
    prNumber: n,
    headSha: String(n).repeat(40).slice(0, 40),
    playbookVersionId: "pv",
  });
  db.prepare("UPDATE reviews SET state=?, started_at=? WHERE id=?").run(
    state,
    new Date(Date.now() - ageMs).toISOString(),
    id,
  );
  return id;
};

describe("recovering reviews a crashed process left behind", () => {
  it("fails an old review still marked in flight", () => {
    // Nothing reset review state on a crash, so an interrupted review sat in `analyzing`
    // for ever. Once the reaper learned to skip containers of in-flight reviews, that
    // orphan became permanently protected — and its containers, the ones the reaper
    // exists to collect after exactly this crash, could never be swept.
    const id = makeReview(1, "analyzing", 60 * 60_000);
    expect(recoverStaleReviews(db, 30 * 60_000)).toBe(1);

    const row = db.prepare("SELECT state, error FROM reviews WHERE id=?").get<{
      state: string;
      error: string | null;
    }>(id);
    expect(row?.state).toBe("failed");
    expect(row?.error).toMatch(/interrupted/);
  });

  it("leaves a review a live worker may still hold", () => {
    // The cutoff must exceed the job lease, or recovery kills work in progress — which
    // would be a far worse bug than the one it fixes.
    makeReview(2, "analyzing", 60_000);
    expect(recoverStaleReviews(db, 30 * 60_000)).toBe(0);
  });

  it("leaves finished reviews alone", () => {
    makeReview(3, "done", 60 * 60_000);
    makeReview(4, "failed", 60 * 60_000);
    expect(recoverStaleReviews(db, 30 * 60_000)).toBe(0);
  });

  it("covers every state the reaper treats as live", () => {
    // The two lists must not drift: a state the reaper protects but recovery ignores is
    // a permanent leak, which is the bug this pair exists to close.
    for (const [i, state] of IN_FLIGHT_STATES.entries()) {
      makeReview(100 + i, state, 60 * 60_000);
    }
    expect(recoverStaleReviews(db, 30 * 60_000)).toBe(IN_FLIGHT_STATES.length);
  });
});

describe("recovery closes what the review left open", () => {
  it("fails the review's unfinished tasks", () => {
    // A failed review whose tasks still say "running" is a contradiction on the board,
    // and it was the state every crashed review left behind.
    const id = makeReview(10, "analyzing", 60 * 60_000);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO tasks (id, review_id, node_id, kind, state, created_at)
       VALUES ('t1', ?, 'agent:security', 'agent', 'running', ?)`,
    ).run(id, now);
    db.prepare(
      `INSERT INTO tasks (id, review_id, node_id, kind, state, created_at)
       VALUES ('t2', ?, 'agent:product', 'agent', 'done', ?)`,
    ).run(id, now);

    recoverStaleReviews(db, 30 * 60_000);

    const states = db
      .prepare("SELECT id, state FROM tasks WHERE review_id=? ORDER BY id")
      .all<{ id: string; state: string }>(id);
    expect(states).toEqual([
      { id: "t1", state: "failed" },
      // A task that genuinely finished keeps its result.
      { id: "t2", state: "done" },
    ]);
  });

  it("marks the review's environments leaked, not destroyed", () => {
    // Whether the container actually went away is unknown. Claiming it was cleaned up is
    // the assertion that hides a disk filling; "leaked" is what the reaper reconciles.
    const id = makeReview(11, "analyzing", 60 * 60_000);
    db.prepare(
      `INSERT INTO environments (id, review_id, kind, state, spec_json, ttl_at, created_at)
       VALUES ('e1', ?, 'analyze', 'running', '{}', datetime('now'), datetime('now'))`,
    ).run(id);

    recoverStaleReviews(db, 30 * 60_000);

    const row = db
      .prepare("SELECT state, destroyed_at FROM environments WHERE id='e1'")
      .get<{ state: string; destroyed_at: string | null }>();
    expect(row?.state).toBe("leaked");
    expect(row?.destroyed_at).toBeTruthy();
  });

  it("leaves a live review's children untouched", () => {
    const id = makeReview(12, "analyzing", 60_000);
    db.prepare(
      `INSERT INTO tasks (id, review_id, node_id, kind, state, created_at)
       VALUES ('t3', ?, 'agent:security', 'agent', 'running', datetime('now'))`,
    ).run(id);

    recoverStaleReviews(db, 30 * 60_000);

    const row = db.prepare("SELECT state FROM tasks WHERE id='t3'").get<{ state: string }>();
    expect(row?.state).toBe("running");
  });
});

describe("the tenant boundary on cancellation", () => {
  /** Two repositories, each with a pull request numbered 7. */
  const twoRepos = () => {
    const a = store.create({
      repoOwner: "acme",
      repoName: "web",
      prNumber: 7,
      headSha: "a".repeat(40),
      playbookVersionId: "pv",
    });
    const b = store.create({
      repoOwner: "other",
      repoName: "api",
      prNumber: 7,
      headSha: "b".repeat(40),
      playbookVersionId: "pv",
    });
    return { a: a.id, b: b.id };
  };

  it("matches only the review belonging to the named repository", () => {
    // Matching on the pull request number alone let a `closed` event in one repository
    // abort reviews in another — including private repositories the sender cannot read.
    // PR numbers are small dense integers, so a collision is the normal case, not an
    // unlucky one.
    const { a, b } = twoRepos();
    const repoA = store.ensureRepo("acme", "web");

    const matched = reviewsForPullRequest(db, [a, b], { repoId: repoA, number: 7 });
    expect(matched).toEqual([a]);
  });

  it("matches nothing for a number that repository does not have", () => {
    const { a, b } = twoRepos();
    const repoA = store.ensureRepo("acme", "web");
    expect(reviewsForPullRequest(db, [a, b], { repoId: repoA, number: 99 })).toEqual([]);
  });

  it("matches nothing for a repository with no reviews in flight", () => {
    const { a, b } = twoRepos();
    const unrelated = store.ensureRepo("third", "party");
    expect(reviewsForPullRequest(db, [a, b], { repoId: unrelated, number: 7 })).toEqual([]);
  });

  it("ignores an id that is not a review", () => {
    // The caller passes whatever is in its in-flight map; a stale key must not throw.
    const { a } = twoRepos();
    const repoA = store.ensureRepo("acme", "web");
    expect(reviewsForPullRequest(db, [a, "rv_gone"], { repoId: repoA, number: 7 })).toEqual([a]);
  });
});

describe("the ticket a review was checked against", () => {
  // `linear_issue_json` sat in the schema from the first migration and nothing wrote it,
  // so the acceptance criteria the product agent judged the diff by lived only inside a
  // prompt that is discarded when the review ends. "Why did it say that on PR 412?" is
  // the question the whole version-pinning design exists to answer.
  it("is stored on the review and comes back with it", () => {
    const { id } = store.create({
      repoOwner: "acme",
      repoName: "web",
      prNumber: 7,
      headSha: "c".repeat(40),
      playbookVersionId: "pv",
    });
    store.setLinearIssue(id, { identifier: "ENG-42", acceptanceCriteria: ["logs out"] });

    const row = db
      .prepare("SELECT linear_issue_json FROM reviews WHERE id=?")
      .get<{ linear_issue_json: string | null }>(id);
    expect(JSON.parse(row?.linear_issue_json ?? "null")).toMatchObject({ identifier: "ENG-42" });
  });

  it("stores null rather than the string 'null' when there is no ticket", () => {
    const { id } = store.create({
      repoOwner: "acme",
      repoName: "web",
      prNumber: 8,
      headSha: "d".repeat(40),
      playbookVersionId: "pv",
    });
    store.setLinearIssue(id, undefined);
    const row = db
      .prepare("SELECT linear_issue_json FROM reviews WHERE id=?")
      .get<{ linear_issue_json: string | null }>(id);
    expect(row?.linear_issue_json).toBeNull();
  });
});
