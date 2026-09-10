import { beforeEach, describe, expect, it } from "vitest";
import { newId } from "./ids.js";
import { ReviewStore } from "./reviews.js";
import { checkSpend, dayAgo, pruneTelemetry, spendSince } from "./spend.js";
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

describe("pruning old telemetry", () => {
  // Nothing in this system had ever deleted anything: every table grew for the life of the
  // install, roughly four and a half million rows a year at a hundred reviews a day,
  // dominated by the per-step trace.
  const trace = (reviewId: string) => {
    db.prepare(
      "INSERT INTO spans (id, review_id, name, status, started_at) VALUES (?,?,?,?,?)",
    ).run(newId("sp"), reviewId, "n", "ok", new Date().toISOString());
    db.prepare(
      `INSERT INTO llm_calls (id, review_id, provider_id, model, cost_cents, created_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(newId("call"), reviewId, "ollama", "m", 1, new Date().toISOString());
    db.prepare(
      `INSERT INTO trajectory_turns (id, review_id, task_id, seq, step, role, content_json, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(newId("turn"), reviewId, null, 0, 0, "assistant", "{}", new Date().toISOString());
  };
  const aged = (reviewId: string, days: number) =>
    db
      .prepare("UPDATE reviews SET state='done', finished_at=? WHERE id=?")
      .run(new Date(Date.now() - days * 24 * 60 * 60_000).toISOString(), reviewId);

  it("drops the step trace of reviews past the cutoff", () => {
    const r = review("acme", "web", 1);
    trace(r);
    aged(r, 90);
    expect(pruneTelemetry(db, 30 * 24 * 60 * 60_000)).toEqual({
      spans: 1,
      llmCalls: 1,
      trajectoryTurns: 1,
    });
  });

  it("keeps the review and its findings, which the quality loop is measured from", () => {
    // The trace is the bulk; the verdicts are the value, and they are small.
    const r = review("acme", "web", 2);
    trace(r);
    aged(r, 90);
    pruneTelemetry(db, 30 * 24 * 60 * 60_000);
    expect(db.prepare("SELECT COUNT(*) AS n FROM reviews").get<{ n: number }>()?.n).toBe(1);
  });

  it("leaves a recent review alone", () => {
    const r = review("acme", "web", 3);
    trace(r);
    aged(r, 1);
    expect(pruneTelemetry(db, 30 * 24 * 60 * 60_000)).toEqual({
      spans: 0,
      llmCalls: 0,
      trajectoryTurns: 0,
    });
  });

  it("leaves a review that is still running alone, however old its row is", () => {
    // An in-flight review's trace is the one somebody is most likely to be reading.
    const r = review("acme", "web", 4);
    trace(r);
    db.prepare("UPDATE reviews SET state='analyzing', created_at=? WHERE id=?").run(
      new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString(),
      r,
    );
    expect(pruneTelemetry(db, 30 * 24 * 60 * 60_000)).toEqual({
      spans: 0,
      llmCalls: 0,
      trajectoryTurns: 0,
    });
  });
});
