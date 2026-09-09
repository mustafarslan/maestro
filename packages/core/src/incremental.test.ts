import { beforeEach, describe, expect, it } from "vitest";
import { newId } from "./ids.js";
import { planIncremental, previousReview, unresolvedFindings } from "./incremental.js";
import { ReviewStore } from "./reviews.js";
import { openStore } from "./store/db.js";
import type { SqlDatabase } from "./store/driver.js";

let db: SqlDatabase;
let reviews: ReviewStore;
let repoId: string;
let pbVersionId: string;

async function seedPlaybookVersion(database: SqlDatabase): Promise<string> {
  const pbId = newId("pb");
  const pvId = newId("pv");
  const now = new Date().toISOString();
  database
    .prepare("INSERT INTO playbooks (id, name, created_at, updated_at) VALUES (?,?,?,?)")
    .run(pbId, "default", now, now);
  database
    .prepare(
      "INSERT INTO playbook_versions (id, playbook_id, version, schema_version, document, created_at) VALUES (?,?,?,?,?,?)",
    )
    .run(pvId, pbId, 1, 1, "{}", now);
  return pvId;
}

function addFinding(database: SqlDatabase, reviewId: string, over: Record<string, unknown> = {}) {
  database
    .prepare(
      `INSERT INTO findings (id, review_id, agent_id, file, line_start, category, severity,
                             confidence, title, body, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      newId("fd"),
      reviewId,
      (over.agent as string) ?? "security",
      "a.ts",
      10,
      (over.category as string) ?? "idor",
      (over.severity as string) ?? "high",
      0.9,
      (over.title as string) ?? "finding",
      "body",
      (over.status as string) ?? "open",
      new Date().toISOString(),
    );
}

beforeEach(async () => {
  db = await openStore({ path: ":memory:" });
  reviews = new ReviewStore(db);
  pbVersionId = await seedPlaybookVersion(db);
  repoId = reviews.ensureRepo("acme", "web");
});

describe("previousReview", () => {
  it("finds the last completed review at a different head sha", () => {
    const first = reviews.create({
      repoOwner: "acme",
      repoName: "web",
      prNumber: 1,
      headSha: "aaa",
      playbookVersionId: pbVersionId,
    });
    reviews.setState(first.id, "done");

    expect(previousReview(db, repoId, 1, "bbb")?.headSha).toBe("aaa");
  });

  it("ignores a review that never completed", () => {
    // Diffing against a SHA whose review failed would present a partial review as
    // though the earlier commits had been checked.
    const first = reviews.create({
      repoOwner: "acme",
      repoName: "web",
      prNumber: 1,
      headSha: "aaa",
      playbookVersionId: pbVersionId,
    });
    reviews.setState(first.id, "failed");

    expect(previousReview(db, repoId, 1, "bbb")).toBeNull();
  });

  it("ignores reviews of a different pull request", () => {
    const other = reviews.create({
      repoOwner: "acme",
      repoName: "web",
      prNumber: 2,
      headSha: "aaa",
      playbookVersionId: pbVersionId,
    });
    reviews.setState(other.id, "done");

    expect(previousReview(db, repoId, 1, "bbb")).toBeNull();
  });
});

describe("unresolvedFindings", () => {
  it("carries forward findings that were posted and never addressed", () => {
    const r = reviews.create({
      repoOwner: "acme",
      repoName: "web",
      prNumber: 1,
      headSha: "aaa",
      playbookVersionId: pbVersionId,
    });
    addFinding(db, r.id, { title: "still broken" });

    expect(unresolvedFindings(db, r.id).map((f) => f.title)).toEqual(["still broken"]);
  });

  it("does not resurrect findings that were suppressed", () => {
    // Something below the reporting threshold last round should not reappear merely
    // because the author pushed again.
    const r = reviews.create({
      repoOwner: "acme",
      repoName: "web",
      prNumber: 1,
      headSha: "aaa",
      playbookVersionId: pbVersionId,
    });
    addFinding(db, r.id, { status: "suppressed" });
    addFinding(db, r.id, { status: "dismissed", category: "other" });

    expect(unresolvedFindings(db, r.id)).toHaveLength(0);
  });
});

describe("planIncremental", () => {
  it("reviews the full diff the first time a pull request is seen", () => {
    const plan = planIncremental(db, { repoId, prNumber: 1, headSha: "aaa", baseSha: "base" });
    expect(plan).toMatchObject({ incremental: false, baseRef: "base" });
  });

  it("scopes to the delta since the previous reviewed head", () => {
    const first = reviews.create({
      repoOwner: "acme",
      repoName: "web",
      prNumber: 1,
      headSha: "aaa",
      playbookVersionId: pbVersionId,
    });
    reviews.setState(first.id, "done");
    addFinding(db, first.id, { title: "carried" });

    const plan = planIncremental(db, { repoId, prNumber: 1, headSha: "bbb", baseSha: "base" });
    expect(plan.incremental).toBe(true);
    expect(plan.baseRef).toBe("aaa");
    expect(plan.carried.map((c) => c.title)).toEqual(["carried"]);
  });

  it("falls back to a full review when incremental is disallowed", () => {
    // A playbook change invalidates the comparison: the new agents never saw the
    // earlier commits.
    const first = reviews.create({
      repoOwner: "acme",
      repoName: "web",
      prNumber: 1,
      headSha: "aaa",
      playbookVersionId: pbVersionId,
    });
    reviews.setState(first.id, "done");

    const plan = planIncremental(db, {
      repoId,
      prNumber: 1,
      headSha: "bbb",
      baseSha: "base",
      allowIncremental: false,
    });
    expect(plan).toMatchObject({ incremental: false, baseRef: "base", carried: [] });
  });
});

describe("carry-forward across a real posting cycle", () => {
  it("carries a finding that posting marked 'posted'", () => {
    // Regression: posting stamps every reported finding 'posted', but the carry-forward
    // query matched only 'open' - so on every real review nothing was ever carried, and
    // a finding reported in round 1 silently vanished from round 2.
    const first = reviews.create({
      repoOwner: "acme",
      repoName: "web",
      prNumber: 1,
      headSha: "aaa",
      playbookVersionId: pbVersionId,
    });
    reviews.setState(first.id, "done");
    addFinding(db, first.id, { title: "still broken", status: "posted" });

    const plan = planIncremental(db, { repoId, prNumber: 1, headSha: "bbb", baseSha: "base" });
    expect(plan.carried.map((c) => c.title)).toEqual(["still broken"]);
  });

  it("still refuses to carry dismissed or accepted findings", () => {
    const first = reviews.create({
      repoOwner: "acme",
      repoName: "web",
      prNumber: 1,
      headSha: "aaa",
      playbookVersionId: pbVersionId,
    });
    reviews.setState(first.id, "done");
    addFinding(db, first.id, { status: "dismissed" });
    addFinding(db, first.id, { status: "accepted", category: "other" });

    expect(
      planIncremental(db, { repoId, prNumber: 1, headSha: "bbb", baseSha: "base" }).carried,
    ).toHaveLength(0);
  });
});

describe("what gets carried into the next review's prompt", () => {
  // Every carried finding becomes a line in every agent's context on the next review.
  // Nothing bounded how many a noisy round could produce, while the changed-file list two
  // lines away in the same prompt has been capped at 100 all along — and the ordering that
  // decides which survive a cap was `ORDER BY severity` on a TEXT column, which is
  // alphabetical.
  it("orders by real severity, not alphabetically", () => {
    const review = reviews.create({
      repoOwner: "acme",
      repoName: "web",
      prNumber: 1,
      headSha: "sev",
      playbookVersionId: pbVersionId,
    }).id;
    for (const severity of ["info", "medium", "critical", "low", "high"]) {
      addFinding(db, review, { severity, title: severity });
    }

    const carried = unresolvedFindings(db, review);
    expect(carried.map((c) => c.severity)).toEqual(["critical", "high", "medium", "low", "info"]);
    // Alphabetically, `medium` would be last of these five — below `info`.
    expect(carried.at(-1)?.severity).not.toBe("medium");
  });

  it("caps how many reach the prompt, keeping the most serious", () => {
    const review = reviews.create({
      repoOwner: "acme",
      repoName: "web",
      prNumber: 2,
      headSha: "cap",
      playbookVersionId: pbVersionId,
    }).id;
    for (let i = 0; i < 60; i++) addFinding(db, review, { severity: "info", title: `noise ${i}` });
    addFinding(db, review, { severity: "critical", title: "the one that matters" });

    const carried = unresolvedFindings(db, review);
    expect(carried.length).toBeLessThanOrEqual(40);
    expect(carried[0]?.title).toBe("the one that matters");
  });
});
