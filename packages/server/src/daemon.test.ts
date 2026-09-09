import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openStore, type SqlDatabase } from "@maestro/core";
import { defaultPlaybook, PlaybookStore } from "@maestro/playbook";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningDaemon, startDaemon, supersedes } from "./daemon.js";

let db: SqlDatabase;
let running: RunningDaemon | undefined;

beforeEach(async () => {
  db = await openStore({ path: ":memory:" });
  new PlaybookStore(db).ensureDefault();
});

afterEach(async () => {
  await running?.stop();
  running = undefined;
  db.close();
});

describe("the webhook listener's secret", () => {
  it("refuses to start without one", async () => {
    // It binds 0.0.0.0 by necessity — GitHub has to reach it — and without a secret it
    // accepted every delivery from anyone, each of which starts a review that spawns
    // containers. A log warning was the only mitigation, which is warning about
    // something and then doing it anyway.
    await expect(startDaemon({ db, webhookPort: 0 })).rejects.toThrow(/secret/i);
  });

  it("says how to fix it, including the environment variable", async () => {
    // An error that names the flag but not the variable sends a Compose user looking in
    // the wrong place.
    await expect(startDaemon({ db, webhookPort: 0 })).rejects.toThrow(/GITHUB_WEBHOOK_SECRET/);
  });

  it("points at --poll, which needs no listener at all", async () => {
    await expect(startDaemon({ db, webhookPort: 0 })).rejects.toThrow(/--poll/);
  });

  it("starts when a secret is supplied", async () => {
    running = await startDaemon({ db, webhookPort: 0, webhookSecret: "s3cret" });
    expect(running.webhookPort).toBeGreaterThan(0);
  });

  it("leaves the admin-only daemon alone, which exposes no public listener", async () => {
    // No webhook port means no unauthenticated surface, so no secret is required.
    running = await startDaemon({ db, adminPort: 0 });
    expect(running.webhookPort).toBeUndefined();
    expect(running.adminToken).toBeTruthy();
  });
});

describe("cancellation is scoped to one repository", () => {
  it("routes both cancel paths through the shared predicate", () => {
    // Deliberately narrow, and titled for what it is. The PROPERTY — that a `closed`
    // event in one repository cannot abort another's review — is asserted behaviourally
    // in packages/core/src/reviews.test.ts, against a real database with two
    // repositories sharing a pull request number. That test fails for every wrong
    // implementation; this one only checks the daemon still delegates rather than
    // growing its own copy of the filter.
    //
    // The previous version of this test asserted the shape of daemon.ts's source and was
    // described as proving the behaviour. It did not: a filter that kept the same words
    // and matched the wrong rows passed it.
    const source = readFileSync(join(import.meta.dirname, "daemon.ts"), "utf8");
    expect(source).toContain("reviewsForPullRequest(db, inFlight.keys()");
    expect(source.match(/inFlightFor\(t\.pr\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("manual-only reviews", () => {
  // The point of the setting, stated as behaviour: with `automaticTriggers: false` a
  // pull request opening starts nothing, and a `@maestro review` comment still does.
  // Asserted through the real webhook listener with a real signature, because the gate
  // has to hold on the path GitHub actually uses — not on a directly-called function.
  const secret = "s3cret";

  const deliver = async (port: number, event: string, payload: unknown): Promise<number> => {
    const raw = JSON.stringify(payload);
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        // What GitHub sends. Computed here rather than pulled from a signing library,
        // so the test does not share an implementation with the code it checks.
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
      },
      body: raw,
    });
    return res.status;
  };

  const queuedReviews = (): number =>
    db.prepare("SELECT COUNT(*) as n FROM jobs WHERE kind='review-pr'").get<{ n: number }>()?.n ??
    -1;

  const opened = {
    action: "opened",
    repository: { name: "maestro", owner: { login: "acme" } },
    pull_request: { number: 7, head: { sha: "abc123" } },
  };
  const requested = (id: number) => ({
    action: "created",
    repository: { name: "maestro", owner: { login: "acme" } },
    issue: { number: 7 },
    comment: { id, body: "@maestro review", author_association: "OWNER" },
  });

  const start = async (automaticTriggers: boolean): Promise<number> => {
    new PlaybookStore(db).publish(
      { ...defaultPlaybook(), router: { ...defaultPlaybook().router, automaticTriggers } },
      { activate: true },
    );
    // No workers: this test is about what gets queued, and a worker would try to run the
    // review — which means Docker and model calls for an assertion about a queue.
    running = await startDaemon({
      db,
      webhookPort: 0,
      webhookSecret: secret,
      concurrentReviews: 0,
    });
    return running.webhookPort as number;
  };

  it("ignores a pull request opening when automatic triggers are off", async () => {
    const port = await start(false);
    expect(await deliver(port, "pull_request", opened)).toBe(202);
    expect(queuedReviews()).toBe(0);
  });

  it("still reviews when somebody asks for one", async () => {
    const port = await start(false);
    expect(await deliver(port, "issue_comment", requested(11))).toBe(202);
    expect(queuedReviews()).toBe(1);
  });

  it("runs a later request rather than swallowing it", async () => {
    // `dedupe_key` is unique across the whole table and rows are never pruned, so keying
    // a request on the pull request alone dropped every later `@maestro review` on it
    // for ever — including after the first review had finished and the person was asking
    // about new commits. The key is the comment, which is what actually asked.
    const port = await start(false);
    await deliver(port, "issue_comment", requested(11));
    db.prepare("UPDATE jobs SET state='done'").run();
    await deliver(port, "issue_comment", requested(12));
    expect(queuedReviews()).toBe(2);
  });

  it("does not stack a second request on one already queued", async () => {
    // Two people asking within a minute are asking for one review, and they will both
    // read the same comment, which is updated in place. The permanent dedupe key cannot
    // express "not while one is pending" without also meaning "not ever again", so the
    // transient question is asked directly.
    const port = await start(false);
    await deliver(port, "issue_comment", requested(11));
    await deliver(port, "issue_comment", requested(12));
    expect(queuedReviews()).toBe(1);
  });

  it("re-reviews on request even when the head has not moved", async () => {
    // Without this the job runs, `reviewPullRequest` finds a review already covering that
    // SHA, and returns "already reviewed at this head sha" — so a person who asked got
    // silence. There is one comment per pull request and it is updated in place, so a
    // re-review refreshes it rather than adding noise.
    const port = await start(false);
    await deliver(port, "issue_comment", requested(11));
    const payload = db
      .prepare("SELECT payload_json FROM jobs WHERE kind='review-pr'")
      .get<{ payload_json: string }>();
    expect(JSON.parse(payload?.payload_json ?? "{}")).toMatchObject({ force: true });
  });

  it("does not force a review the pull request asked for itself", async () => {
    // Automatic triggers must stay idempotent per head SHA: a redelivered `opened` event
    // that forced would re-run a completed review.
    const port = await start(true);
    await deliver(port, "pull_request", opened);
    const payload = db
      .prepare("SELECT payload_json FROM jobs WHERE kind='review-pr'")
      .get<{ payload_json: string }>();
    expect(JSON.parse(payload?.payload_json ?? "{}")).toMatchObject({ force: false });
  });

  it("does not re-run a redelivered request", async () => {
    // GitHub redelivers; the same comment must not queue twice.
    const port = await start(false);
    await deliver(port, "issue_comment", requested(11));
    await deliver(port, "issue_comment", requested(11));
    expect(queuedReviews()).toBe(1);
  });

  it("reviews on the pull request's own lifecycle by default", async () => {
    // The default has to stay automatic: an installation that changed nothing must keep
    // behaving as it did.
    const port = await start(true);
    expect(await deliver(port, "pull_request", opened)).toBe(202);
    expect(queuedReviews()).toBe(1);
  });
});

describe("what cancels a review already running", () => {
  const pr = { owner: "acme", repo: "maestro", number: 7 };

  it("a push, because the running review can no longer be posted", () => {
    const t = { kind: "review", pr, headSha: "new", reason: "synchronize", source: "lifecycle" };
    expect(supersedes(t as never, "old")).toBe(true);
  });

  it("not the same push arriving twice", () => {
    const t = { kind: "review", pr, headSha: "same", reason: "synchronize", source: "lifecycle" };
    expect(supersedes(t as never, "same")).toBe(false);
  });

  it("never a person asking for a review", () => {
    // This is the bug the helper exists for. A comment has no head SHA, so the old
    // inline comparison was false for every running review and aborted all of them:
    // asking for a review killed the review in progress, and asking twice killed the
    // one you had just asked for.
    const t = {
      kind: "review",
      pr,
      headSha: "",
      reason: "requested by a maestro review comment",
      source: "comment",
      commentId: 11,
    };
    expect(supersedes(t as never, "old")).toBe(false);
  });
});
