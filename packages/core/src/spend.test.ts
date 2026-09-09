import { beforeEach, describe, expect, it } from "vitest";
import { newId } from "./ids.js";
import { ReviewStore } from "./reviews.js";
import { checkSpend, dayAgo, spendSince } from "./spend.js";
import { openStore } from "./store/db.js";
import type { SqlDatabase } from "./store/driver.js";

let db: SqlDatabase;

beforeEach(async () => {
  db = await openStore({ path: ":memory:" });
  // reviews.playbook_version_id is a foreign key; every review is pinned to a version.
  db.prepare(
    `INSERT INTO playbooks (id, name, created_at, updated_at)
     VALUES ('pb','default',datetime('now'),datetime('now'))`,
  ).run();
  db.prepare(
    `INSERT INTO playbook_versions (id, playbook_id, version, schema_version, document, created_at)
     VALUES ('pv','pb',1,1,'{}',datetime('now'))`,
  ).run();
});

const review = (owner: string, repo: string, prNumber: number): string =>
  new ReviewStore(db).create({
    repoOwner: owner,
    repoName: repo,
    prNumber,
    headSha: newId("rv"),
    playbookVersionId: "pv",
  }).id;

const spend = (reviewId: string, cents: number, at = new Date().toISOString()): void => {
  db.prepare(
    `INSERT INTO llm_calls (id, review_id, provider_id, model, cost_cents, created_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(newId("call"), reviewId, "ollama", "m", cents, at);
};

describe("what has been spent", () => {
  it("sums only the window asked for", () => {
    const r = review("acme", "web", 1);
    spend(r, 100);
    spend(r, 50, new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());
    expect(spendSince(db, dayAgo())).toBe(100);
  });

  it("scopes to one repository", () => {
    // Reads from llm_calls rather than reviews.cost_cents: a review still running has
    // spent money that has not been rolled up yet, and that is the money a cap must see.
    spend(review("acme", "web", 1), 100);
    spend(review("other", "api", 1), 700);
    const repoId = new ReviewStore(db).ensureRepo("acme", "web");
    expect(spendSince(db, dayAgo(), { repoId })).toBe(100);
    expect(spendSince(db, dayAgo())).toBe(800);
  });
});

describe("whether another review may start", () => {
  it("allows everything when no cap is set, which is the default", () => {
    spend(review("acme", "web", 1), 100_000);
    expect(checkSpend(db, {}).allowed).toBe(true);
  });

  it("refuses once the global daily cap is reached", () => {
    spend(review("acme", "web", 1), 500);
    const v = checkSpend(db, { dailyCapCents: 500 });
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/daily cap reached/);
    expect(v.reason).toContain("$5.00");
  });

  it("refuses one busy repository without stopping the others", () => {
    // The reason the per-repo cap exists: a single repository must not consume the whole
    // allowance and leave every other repository unreviewed.
    spend(review("acme", "web", 1), 500);
    const busy = new ReviewStore(db).ensureRepo("acme", "web");
    const quiet = new ReviewStore(db).ensureRepo("other", "api");
    expect(checkSpend(db, { perRepoDailyCapCents: 400 }, { repoId: busy }).allowed).toBe(false);
    expect(checkSpend(db, { perRepoDailyCapCents: 400 }, { repoId: quiet }).allowed).toBe(true);
  });

  it("ignores spend that has aged out of the window", () => {
    spend(review("acme", "web", 1), 900, new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
    expect(checkSpend(db, { dailyCapCents: 100 }).allowed).toBe(true);
  });
});
