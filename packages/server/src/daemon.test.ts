import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobQueue, newId, openStore, ReviewStore, type SqlDatabase } from "@maestro/core";
import { GitHubClient } from "@maestro/integrations";
import { defaultPlaybook, PlaybookStore } from "@maestro/playbook";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  /** Acknowledgement is fire-and-forget, so the 202 arrives before it has happened. */
  const waitFor = async (cond: () => boolean, ms = 3000): Promise<void> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("condition never became true");
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
    issue: { number: 7, pull_request: { url: "https://api.github.com/…/pulls/7" } },
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

  it("reacts to the comment that asked, so the asker is not left in silence", async () => {
    // A review takes minutes. Until it posted, asking produced nothing at all — no
    // reaction, no comment — which is indistinguishable from a bot that is broken or was
    // never installed. Observed on this project's own first live request: the comment sat
    // there for twelve minutes while three agents worked.
    const reacted: { commentId: number; content: string }[] = [];
    vi.spyOn(GitHubClient, "fromEnv").mockReturnValue({
      reactToComment: async (_pr: unknown, commentId: number, content: string) => {
        reacted.push({ commentId, content });
        return true;
      },
    } as unknown as GitHubClient);

    const port = await start(true);
    expect(await deliver(port, "issue_comment", requested(4242))).toBe(202);
    await waitFor(() => reacted.length > 0);
    expect(reacted[0]).toEqual({ commentId: 4242, content: "eyes" });
  });

  it("does not react to a review the pull request asked for itself", async () => {
    // Nobody is waiting on an answer to a `pull_request.opened` event, and reacting to a
    // comment nobody wrote is not possible anyway.
    const reacted: unknown[] = [];
    vi.spyOn(GitHubClient, "fromEnv").mockReturnValue({
      reactToComment: async () => {
        reacted.push(1);
        return true;
      },
    } as unknown as GitHubClient);

    const port = await start(true);
    expect(await deliver(port, "pull_request", opened)).toBe(202);
    await waitFor(() => queuedReviews() > 0);
    expect(reacted).toEqual([]);
  });

  it("queues the review even when acknowledging it fails", async () => {
    // The reaction is courtesy; the review is the point. A revoked token, a deleted
    // comment or a rate limit must not cost somebody their review.
    vi.spyOn(GitHubClient, "fromEnv").mockReturnValue({
      reactToComment: async () => {
        throw new Error("403 rate limited");
      },
    } as unknown as GitHubClient);

    const port = await start(true);
    expect(await deliver(port, "issue_comment", requested(99))).toBe(202);
    await waitFor(() => queuedReviews() > 0);
    expect(queuedReviews()).toBe(1);
  });

  const scoped = (id: number, body: string) => ({
    action: "created",
    repository: { name: "maestro", owner: { login: "acme" } },
    issue: { number: 7, pull_request: { url: "https://api.github.com/…/pulls/7" } },
    comment: { id, body, author_association: "OWNER" },
  });

  const payloadOf = (): { agents?: string[] } =>
    JSON.parse(
      db
        .prepare("SELECT payload_json FROM jobs WHERE kind='review-pr' ORDER BY rowid DESC LIMIT 1")
        .get<{ payload_json: string }>()?.payload_json ?? "{}",
    );

  it("scopes a review to the agent somebody named", async () => {
    const port = await start(true);
    expect(await deliver(port, "issue_comment", scoped(5001, "@maestro review security"))).toBe(
      202,
    );
    await waitFor(() => queuedReviews() > 0);
    expect(payloadOf().agents).toEqual(["security"]);
  });

  it("takes several named agents", async () => {
    const port = await start(true);
    expect(
      await deliver(port, "issue_comment", scoped(5002, "@maestro review security, architecture")),
    ).toBe(202);
    await waitFor(() => queuedReviews() > 0);
    expect(payloadOf().agents?.sort()).toEqual(["architecture", "security"]);
  });

  it("still runs the whole crew for words that name no agent", async () => {
    // `@maestro review it please` has always worked and has to keep working; the parser
    // cannot tell an English sentence from an agent name, and the playbook can.
    const port = await start(true);
    expect(await deliver(port, "issue_comment", scoped(5003, "@maestro review it please"))).toBe(
      202,
    );
    await waitFor(() => queuedReviews() > 0);
    expect(payloadOf().agents).toBeUndefined();
  });

  it("reviews with everything when the named agent is misspelt, rather than refusing", async () => {
    // The deliberate trade-off. A parser that cannot distinguish a typo from prose will
    // sometimes give more than was asked for; giving less — silently skipping the review
    // somebody wanted — is the failure worth avoiding. The metrics block lists which
    // agents ran, so a full review is never mistaken for a scoped one.
    const port = await start(true);
    expect(await deliver(port, "issue_comment", scoped(5004, "@maestro review securty"))).toBe(202);
    await waitFor(() => queuedReviews() > 0);
    expect(payloadOf().agents).toBeUndefined();
  });

  it("reviews on the pull request's own lifecycle by default", async () => {
    // The default has to stay automatic: an installation that changed nothing must keep
    // behaving as it did.
    const port = await start(true);
    expect(await deliver(port, "pull_request", opened)).toBe(202);
    expect(queuedReviews()).toBe(1);
  });
});

describe("spend caps stop a review before it starts", () => {
  // A router tier caps one review and a model binding caps one agent; neither can see
  // that a repository has run two hundred today. With `@maestro review` able to
  // re-review an unchanged head, nothing else bounds aggregate spend.
  const secret = "s3cret";
  const deliver = async (port: number, event: string, payload: unknown): Promise<number> => {
    const raw = JSON.stringify(payload);
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
      },
      body: raw,
    });
    return res.status;
  };
  const opened = {
    action: "opened",
    repository: { name: "maestro", owner: { login: "acme" } },
    pull_request: { number: 7, head: { sha: "abc123" } },
  };

  const spend = (cents: number) => {
    const pb = new PlaybookStore(db).getActive("default");
    const { id } = new ReviewStore(db).create({
      repoOwner: "acme",
      repoName: "maestro",
      prNumber: 1,
      headSha: "old",
      playbookVersionId: pb?.id as string,
    });
    db.prepare(
      `INSERT INTO llm_calls (id, review_id, provider_id, model, cost_cents, created_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(newId("call"), id, "ollama", "m", cents, new Date().toISOString());
  };

  const startWithCap = async (dailyCapCents?: number): Promise<number> => {
    const base = defaultPlaybook();
    new PlaybookStore(db).publish(
      { ...base, budget: dailyCapCents === undefined ? {} : { dailyCapCents } },
      { activate: true },
    );
    running = await startDaemon({
      db,
      webhookPort: 0,
      webhookSecret: secret,
      concurrentReviews: 0,
    });
    return running.webhookPort as number;
  };

  const queued = (): number =>
    db.prepare("SELECT COUNT(*) as n FROM jobs WHERE kind='review-pr'").get<{ n: number }>()?.n ??
    -1;

  it("refuses once the cap is reached", async () => {
    spend(500);
    const port = await startWithCap(500);
    expect(await deliver(port, "pull_request", opened)).toBe(202);
    expect(queued()).toBe(0);
  });

  it("reviews normally below the cap", async () => {
    spend(100);
    const port = await startWithCap(500);
    await deliver(port, "pull_request", opened);
    expect(queued()).toBe(1);
  });

  it("has no cap by default, so an install that asked for nothing gets nothing", async () => {
    spend(100_000);
    const port = await startWithCap(undefined);
    await deliver(port, "pull_request", opened);
    expect(queued()).toBe(1);
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

  it("never a person asking, even if their trigger somehow carried a sha", () => {
    // The `source` check and the empty-sha check overlap for real comment triggers, which
    // always carry `headSha: ""` — so mutation showed the source check could be deleted
    // with nothing failing. It encodes an intent the sha coincidence does not: a person
    // asking supersedes nothing, whatever else is on the trigger. Pinned directly.
    const t = {
      kind: "review",
      pr,
      headSha: "different-from-the-running-one",
      reason: "requested by a maestro review comment",
      source: "comment",
      commentId: 11,
    };
    expect(supersedes(t as never, "old")).toBe(false);
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

describe("the poller survives what it cannot control", () => {
  it("handles a tick rejection rather than letting it terminate the process", async () => {
    // Deliberately narrow, and titled for what it checks. The first version of this test
    // asserted that a malformed stored private key could not crash the daemon, and passed
    // with the guard removed — because the premise was wrong: Octokit's constructor does
    // not throw on a bad PEM, it rejects on the first request, which `tick` already
    // catches per repository. A test whose premise is false is worse than no test.
    //
    // What is actually true and worth keeping is the shape: `void p` discards a promise
    // without handling its rejection, and a rejection from a timer callback terminates
    // the process. So the property asserted is the one the code can guarantee — the
    // timer callback attaches a handler.
    const source = readFileSync(join(import.meta.dirname, "daemon.ts"), "utf8");
    expect(source).not.toMatch(/setInterval\(\(\) => void tick\(\)/);
    expect(source).toMatch(/tick\(\)\.catch\(/);
  });
});

describe("a delivery whose body arrives in pieces", () => {
  let db: SqlDatabase;
  let running: Awaited<ReturnType<typeof startDaemon>> | undefined;
  const secret = "s3cret";

  beforeEach(async () => {
    db = await openStore({ path: ":memory:" });
    new PlaybookStore(db).publish(defaultPlaybook(), { activate: true });
    running = await startDaemon({
      db,
      webhookPort: 0,
      webhookSecret: secret,
      concurrentReviews: 0,
    });
  });
  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  /**
   * Writes the request in two pieces, splitting the body inside a character.
   *
   * `fetch` will not do this, and it is the only shape that shows the defect: the
   * receiver appended each chunk to a string, which decodes each chunk on its own, so a
   * character whose UTF-8 bytes straddle the boundary became two replacement characters.
   * The reconstructed body then no longer matched what GitHub signed, and a genuine
   * delivery was rejected as forged — intermittently, depending on where TCP split it.
   */
  const deliverSplit = (port: number, body: string, splitAtByte: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const buf = Buffer.from(body, "utf8");
      const signature = createHmac("sha256", secret).update(buf).digest("hex");
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          [
            "POST / HTTP/1.1",
            "Host: 127.0.0.1",
            "content-type: application/json",
            "x-github-event: pull_request",
            `x-hub-signature-256: sha256=${signature}`,
            `content-length: ${buf.length}`,
            "connection: close",
            "",
            "",
          ].join("\r\n"),
        );
        socket.write(buf.subarray(0, splitAtByte));
        // A second event-loop turn, so the receiver sees two 'data' events.
        setTimeout(() => socket.write(buf.subarray(splitAtByte)), 10);
      });
      let response = "";
      socket.on("data", (d) => {
        response += d.toString("latin1");
      });
      socket.on("error", reject);
      socket.on("close", () => resolve(Number(response.split(" ")[1] ?? 0)));
    });

  it("accepts a signature over a body split inside a multi-byte character", async () => {
    const body = JSON.stringify({
      action: "opened",
      repository: { name: "maestro", owner: { login: "acme" } },
      // The rocket is four bytes, and a pull request title with an emoji is ordinary.
      pull_request: { number: 7, title: "fix 🚀 the thing", head: { sha: "abc123" } },
    });
    const buf = Buffer.from(body, "utf8");
    const split = buf.indexOf(Buffer.from("🚀", "utf8")) + 2;
    expect(split).toBeGreaterThan(2);

    expect(await deliverSplit(running?.webhookPort as number, body, split)).toBe(202);
  }, 15_000);
});

describe("backpressure when the disk is full", () => {
  /**
   * Phase 7 asks for "backpressure when Docker, disk or budget saturates". Only the
   * budget half existed. A review clones a repository, installs its dependencies and
   * commits a snapshot image; started with no space it fails at a different point every
   * time — `docker commit`, the install, a SQLite write — and none of those failures says
   * the disk is full.
   */
  let db: SqlDatabase;
  let running: Awaited<ReturnType<typeof startDaemon>> | undefined;

  beforeEach(async () => {
    db = await openStore({ path: ":memory:" });
    new PlaybookStore(db).publish(defaultPlaybook(), { activate: true });
  });
  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  const attempts = (): number =>
    db.prepare("SELECT attempts FROM jobs WHERE kind='review-pr'").get<{ attempts: number }>()
      ?.attempts ?? -1;

  const queueOne = () =>
    new JobQueue(db).enqueue({
      kind: "review-pr",
      payload: { owner: "acme", repo: "maestro", number: 7 },
      dedupeKey: "acme/maestro#7@abc",
    });

  it("leaves queued work queued rather than claiming it", async () => {
    queueOne();
    running = await startDaemon({ db, minFreeBytes: Number.MAX_SAFE_INTEGER });
    await new Promise((r) => setTimeout(r, 300));
    // Never claimed: `claim` increments `attempts`, so zero attempts is the evidence.
    // Unclaimed work waits for room and runs when there is some — refusing at enqueue
    // instead would drop the webhook that asked, and nothing asks twice.
    expect(attempts()).toBe(0);
  }, 15_000);

  it("claims it when there is room", async () => {
    // The other half of the assertion: without this, a worker that never claims anything
    // would pass the test above for the wrong reason.
    queueOne();
    running = await startDaemon({ db, minFreeBytes: 1 });
    await new Promise((r) => setTimeout(r, 500));
    // Claimed. It then fails for want of a GitHub credential and is requeued for a
    // retry, so `state` is 'queued' again by now — which is why this asserts on
    // `attempts` rather than on the state, and why the pause test does too.
    expect(attempts()).toBeGreaterThan(0);
  }, 15_000);
});

describe("a daemon that cannot bind its webhook port", () => {
  let db: SqlDatabase;
  let holder: Server;
  let port: number;

  beforeEach(async () => {
    db = await openStore({ path: ":memory:" });
    new PlaybookStore(db).publish(defaultPlaybook(), { activate: true });
    holder = createServer();
    await new Promise<void>((r) => holder.listen(0, "0.0.0.0", r));
    port = (holder.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise((r) => holder.close(r));
  });

  it("says so in a sentence", async () => {
    await expect(
      startDaemon({ db, webhookPort: port, webhookSecret: "s3cret", concurrentReviews: 0 }),
    ).rejects.toThrow(/webhook listener cannot bind.*already listening/s);
  }, 15_000);

  it("does not leave its admin server bound", async () => {
    // The admin server binds and the workers start before the webhook listener does, so
    // throwing straight out left both running. Invisible from the CLI, which exits;
    // in-process the next start finds its own admin port taken.
    const admin = 7891;
    await expect(
      startDaemon({
        db,
        adminPort: admin,
        webhookPort: port,
        webhookSecret: "s3cret",
        concurrentReviews: 0,
      }),
    ).rejects.toThrow();

    // Binding it now proves nothing else holds it.
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(admin, "127.0.0.1", resolve);
    });
    await new Promise((r) => probe.close(r));
  }, 15_000);
});

describe("the reaper sweeps on startup", () => {
  /**
   * The plan says the reaper "sweeps on startup and on an interval". Only the interval
   * existed, so the first sweep was ten minutes away — and it would not have touched a
   * crashed daemon's containers anyway, because they are minutes old and the periodic
   * sweep's age filter is two hours. Containers held their memory and their snapshot
   * layers for at least that long, at exactly the moment strays are likeliest.
   */
  let db: SqlDatabase;
  let version: string;
  let running: Awaited<ReturnType<typeof startDaemon>> | undefined;

  beforeEach(async () => {
    db = await openStore({ path: ":memory:" });
    version = new PlaybookStore(db).publish(defaultPlaybook(), { activate: true }).id;
  });
  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  const spyDriver = () => {
    const calls: { olderThanMs?: number; protectReviewIds?: string[] }[] = [];
    const driver = {
      available: async () => true,
      reap: async (opts?: { olderThanMs?: number; protectReviewIds?: string[] }) => {
        calls.push(opts ?? {});
        return { containers: 0, images: 0 };
      },
    } as never;
    return { driver, calls };
  };

  it("reaps once before the interval, not only after it", async () => {
    const { driver, calls } = spyDriver();
    running = await startDaemon({ db, driver, concurrentReviews: 0 });
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.length).toBe(1);
  }, 15_000);

  it("uses an age short enough to catch what a crash just left behind", async () => {
    // Minutes, not hours. A container from a killed daemon is seconds old.
    const { driver, calls } = spyDriver();
    running = await startDaemon({ db, driver, concurrentReviews: 0 });
    await new Promise((r) => setTimeout(r, 100));
    expect(calls[0]?.olderThanMs).toBeLessThanOrEqual(10 * 60_000);
    expect(calls[0]?.olderThanMs).toBeGreaterThan(0);
  }, 15_000);

  it("still names the reviews it must not touch", async () => {
    // The startup sweep is only safe because of this: a second daemon's in-flight
    // reviews are in the same store, so its containers are protected too.
    const reviews = new ReviewStore(db);
    const reviewId = reviews.create({
      repoOwner: "acme",
      repoName: "web",
      prNumber: 1,
      headSha: "a".repeat(40),
      playbookVersionId: version,
    }).id;
    reviews.setState(reviewId, "analyzing");

    const { driver, calls } = spyDriver();
    running = await startDaemon({ db, driver, concurrentReviews: 0 });
    await new Promise((r) => setTimeout(r, 100));
    expect(calls[0]?.protectReviewIds).toContain(reviewId);
  }, 15_000);
});

describe("what a restart says about reviews it did not start", () => {
  /**
   * The 30-minute cutoff is deliberate: it exceeds the job lease, so a review a live
   * worker is still running can never be mistaken for an orphan and have its containers
   * destroyed underneath it. Its consequence is not obvious from outside — after a kill
   * and an immediate restart the board shows those reviews as in flight and nothing says
   * why, which reads as stuck.
   */
  let db: SqlDatabase;
  let version: string;
  let running: Awaited<ReturnType<typeof startDaemon>> | undefined;

  beforeEach(async () => {
    db = await openStore({ path: ":memory:" });
    version = new PlaybookStore(db).publish(defaultPlaybook(), { activate: true }).id;
  });
  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  it("leaves a recent in-flight review alone rather than failing it", async () => {
    const reviews = new ReviewStore(db);
    const id = reviews.create({
      repoOwner: "acme",
      repoName: "web",
      prNumber: 2,
      headSha: "c".repeat(40),
      playbookVersionId: version,
    }).id;
    reviews.setState(id, "analyzing");

    running = await startDaemon({ db, concurrentReviews: 0 });
    // Still analyzing: another worker may hold it, and destroying a live review's
    // containers is the failure this cutoff exists to prevent.
    expect(
      db.prepare("SELECT state FROM reviews WHERE id=?").get<{ state: string }>(id)?.state,
    ).toBe("analyzing");
  }, 15_000);

  it("fails one that is older than the cutoff", async () => {
    // The other half: a daemon that never recovered anything would pass the test above,
    // and an orphan protected for ever is a container that can never be collected.
    const reviews = new ReviewStore(db);
    const id = reviews.create({
      repoOwner: "acme",
      repoName: "web",
      prNumber: 3,
      headSha: "d".repeat(40),
      playbookVersionId: version,
    }).id;
    reviews.setState(id, "analyzing");
    const longAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    db.prepare("UPDATE reviews SET created_at=?, started_at=? WHERE id=?").run(
      longAgo,
      longAgo,
      id,
    );

    running = await startDaemon({ db, concurrentReviews: 0 });
    expect(
      db.prepare("SELECT state FROM reviews WHERE id=?").get<{ state: string }>(id)?.state,
    ).toBe("failed");
  }, 15_000);
});
