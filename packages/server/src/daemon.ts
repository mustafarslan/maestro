import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  IN_FLIGHT_STATES,
  JobQueue,
  logger,
  ReviewStore,
  recoverStaleReviews,
  reviewsForPullRequest,
  SpanRecorder,
  type SqlDatabase,
} from "@maestro/core";
import {
  diffPoll,
  GitHubClient,
  ingestLineChanges,
  ingestReaction,
  interpretEvent,
  LinearClient,
  newPollState,
  type PullRequestRef,
  type ReviewTrigger,
  reviewPullRequest,
  verifySignature,
} from "@maestro/integrations";
import { ProviderConfigStore } from "@maestro/llm";
import { PlaybookStore } from "@maestro/playbook";
import { DockerSandboxDriver } from "@maestro/sandbox";
import { type RunningAdmin, startAdminServer } from "./admin.js";
import { DEFAULT_LIMITS, Scheduler, type SchedulerLimits } from "./scheduler.js";

export interface DaemonOptions {
  db: SqlDatabase;
  /** Webhook listener: must be reachable by GitHub. Signature-verified, nothing else. */
  webhookPort?: number;
  webhookSecret?: string;
  /** Admin API + UI: loopback + token by default, never exposed alongside webhooks. */
  adminPort?: number;
  adminHost?: string;
  adminToken?: string;
  /** Repositories to poll, for hosts with no public URL. */
  poll?: { repos: string[]; intervalMs: number };
  limits?: SchedulerLimits;
  concurrentReviews?: number;
}

export interface RunningDaemon {
  webhookPort?: number;
  adminPort?: number;
  adminToken: string;
  stop(): Promise<void>;
}

/**
 * The long-running process.
 *
 * The two HTTP listeners are deliberately separate. The webhook receiver is the only
 * thing that must be reachable from the internet, and it does signature verification and
 * nothing else; the admin API and UI bind to loopback behind a token. Serving both from
 * one port would expose the admin surface wherever webhooks are reachable.
 */
/** How long a claimed job stays claimed without renewal. Renewed at a third of this. */
const LEASE_MS = 15 * 60_000;

/**
 * Whether a trigger makes an in-flight review of the same pull request pointless.
 *
 * Only a push does. A comment carries no head SHA, so the previous inline test
 * (`review.head_sha === t.headSha`) was never true for one, and every `@maestro review`
 * aborted whatever was already running on that pull request — asking for a review
 * destroyed the review in progress, and asking twice destroyed the one you had just
 * asked for. A person asking supersedes nothing; their request queues behind the work.
 */
export function supersedes(
  t: Extract<ReviewTrigger, { kind: "review" }>,
  reviewHeadSha: string | undefined,
): boolean {
  if (t.source !== "lifecycle") return false;
  // An unknown SHA on either side is not evidence of staleness.
  if (!reviewHeadSha || !t.headSha) return false;
  return reviewHeadSha !== t.headSha;
}

export async function startDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
  // Validated before ANY resource exists. Throwing later — as the missing-secret check
  // first did — leaves the worker pool, the timers and the admin server running with no
  // handle to stop them, because the caller never received one. Every startup failure
  // had that shape; this one just made it visible.
  //
  // The listener binds 0.0.0.0 by necessity, since GitHub has to reach it. Without a
  // secret it accepted every delivery from anyone, each of which starts a review that
  // spawns containers, and a log warning was the only mitigation — which is warning
  // about something and then doing it anyway. There is no legitimate secretless
  // deployment: a GitHub App always has one.
  if (opts.webhookPort !== undefined && !opts.webhookSecret) {
    throw new Error(
      "refusing to start the webhook listener without a secret: it binds 0.0.0.0 and would " +
        "accept unverified deliveries from anyone, each of which starts a review. Pass " +
        "--webhook-secret or set GITHUB_WEBHOOK_SECRET (any random string, matching the one " +
        "configured in the GitHub App). Use --poll instead if you do not want a listener.",
    );
  }

  const { db } = opts;
  const queue = new JobQueue(db, `daemon_${process.pid}`);
  const reviews = new ReviewStore(db);
  const playbooks = new PlaybookStore(db);
  const providers = new ProviderConfigStore(db);
  providers.ensureDefaults();
  const driver = new DockerSandboxDriver();
  const scheduler = new Scheduler(opts.limits ?? DEFAULT_LIMITS);
  const adminToken = opts.adminToken ?? randomBytes(24).toString("hex");

  // A crash leaves reviews mid-flight for ever, and the reaper now skips containers
  // belonging to in-flight reviews — so without this an orphan is protected permanently
  // and its containers can never be collected, by the very sweep that exists for crashes.
  // The cutoff exceeds the job lease so a review a live worker still holds is never
  // mistaken for an orphan.
  const recovered = recoverStaleReviews(db, LEASE_MS * 2);
  if (recovered) logger.warn({ recovered }, "failed reviews left behind by a previous process");

  const inFlight = new Map<string, AbortController>();
  let stopping = false;

  const admin: RunningAdmin | undefined =
    opts.adminPort === undefined
      ? undefined
      : await startAdminServer({
          db,
          port: opts.adminPort,
          host: opts.adminHost,
          token: adminToken,
        });
  const notify = (event: string, data: unknown) => admin?.broadcast(event, data);

  /**
   * Records which of the previous review's findings point at code that has since changed.
   *
   * Best-effort and never on the critical path: this is measurement, and failing to
   * measure must not stop a review from being queued.
   */
  const recordLineChanges = async (pr: PullRequestRef): Promise<void> => {
    try {
      const client = GitHubClient.fromEnv();
      if (!client) return;
      const repoId = reviews.ensureRepo(pr.owner, pr.repo);
      const last = db
        .prepare(
          `SELECT id FROM reviews WHERE repo_id=? AND pr_number=? AND state='done'
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get<{ id: string }>(repoId, pr.number);
      if (!last) return;

      const changed = await ingestLineChanges(db, client, pr, last.id);
      if (changed) logger.info({ reviewId: last.id, changed }, "findings whose file changed");
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, "line-change ingest failed");
    }
  };

  /**
   * In-flight reviews of one pull request, matched on repository AND number.
   *
   * Matching on the number alone was a cross-repository abort: `inFlight` holds reviews
   * for every repo this daemon serves, and PR numbers are small dense integers, so a
   * `closed` event for one repo killed the review of any other repo with the same
   * number. Anyone able to open and close pull requests in one repository could sweep
   * numbers and abort reviews of private repositories they cannot read. Both the cancel
   * and supersede paths had it — the newer one copied the older rather than noticing.
   */
  const inFlightFor = (pr: PullRequestRef): string[] =>
    reviewsForPullRequest(db, inFlight.keys(), {
      repoId: reviews.ensureRepo(pr.owner, pr.repo),
      number: pr.number,
    });

  /** Enqueue rather than review inline: the HTTP handler must return immediately. */
  const enqueueTrigger = (t: ReviewTrigger): void => {
    // Reactions are the feedback signal precision is measured from, not review triggers.
    if (t.kind === "feedback") {
      const result = ingestReaction(db, t.commentId, t.reaction, t.actor);
      if (result) {
        logger.info({ ...result, reaction: t.reaction }, "feedback ingested");
        notify("review", { reviewId: result.reviewId, feedback: true });
      }
      return;
    }
    // A closed or drafted pull request: stop the review rather than letting it finish a
    // comment nobody will read. The `cancel` variant existed and nothing produced or
    // consumed it, so this fell through to "ignored".
    if (t.kind === "cancel") {
      for (const reviewId of inFlightFor(t.pr)) {
        logger.info({ reviewId, reason: t.reason }, "cancelling review for a closed pull request");
        inFlight.get(reviewId)?.abort();
      }
      return;
    }

    if (t.kind !== "review") {
      logger.debug({ reason: t.reason }, "trigger ignored");
      return;
    }

    // Opt-in mode: the pull request's own lifecycle starts nothing, and a review happens
    // when somebody with write access asks for one. Read from the repo's active playbook
    // rather than a flag, so it travels with the rest of the configuration and can differ
    // between repositories.
    if (t.source === "lifecycle") {
      const repoId = reviews.ensureRepo(t.pr.owner, t.pr.repo);
      const active = playbooks.resolveForRepo(repoId);
      if (active && active.doc.router.automaticTriggers === false) {
        logger.info(
          { pr: t.pr.number, reason: t.reason },
          "automatic reviews are off for this repository; comment '@maestro review' to ask for one",
        );
        return;
      }
    }
    // The dedupe key is the idempotency key: webhook redelivery and the poller racing
    // the webhook both collapse to one job.
    //
    // A requested review keys on the comment rather than the SHA. `dedupe_key` is unique
    // across the whole table and rows are never pruned, so keying every request on the
    // pull request would drop the second `@maestro review` on it — for ever, including
    // after the first review finished. Redelivery repeats the comment id, so idempotency
    // is unchanged; a person asking again gets the review they asked for.
    const key =
      t.source === "comment"
        ? `${t.pr.owner}/${t.pr.repo}#${t.pr.number}@comment-${t.commentId}`
        : `${t.pr.owner}/${t.pr.repo}#${t.pr.number}@${t.headSha || "latest"}`;
    const id = queue.enqueue({ kind: "review-pr", payload: t.pr, dedupeKey: key });
    logger.info({ key, reason: t.reason, enqueued: Boolean(id) }, "review trigger");

    // A push is the moment to ask whether the last review's findings were acted on.
    // `ingestLineChanges` existed for this from the beginning and nothing ever called
    // it, so the strongest available quality signal — the only one needing no human
    // action — was never gathered, while STATUS described its granularity as a known
    // limitation, which implied it ran.
    void recordLineChanges(t.pr);

    // A new head SHA makes any in-flight review of this PR unpostable; cancel it so it
    // stops holding a container and a scheduler slot.
    for (const reviewId of inFlightFor(t.pr)) {
      if (!supersedes(t, reviews.get(reviewId)?.head_sha)) continue;
      logger.info({ reviewId }, "cancelling superseded in-flight review");
      inFlight.get(reviewId)?.abort();
    }
  };

  // ── worker loop ─────────────────────────────────────────────────────────
  const workers: Promise<void>[] = [];
  const workerCount = opts.concurrentReviews ?? 3;

  // Optional: absent when LINEAR_API_KEY is unset, and reviews simply run without
  // ticket context rather than failing.
  const linear = LinearClient.fromEnv();
  if (linear) logger.info("linear issue lookup enabled");

  const runOne = async (pr: PullRequestRef): Promise<void> => {
    const client = GitHubClient.fromEnv();
    if (!client) throw new Error("no GitHub credential configured");
    // Per-repo playbook assignment: a mobile repo and a backend repo want different
    // personas and env specs, which is the reason `repos.playbook_id` exists.
    // `resolveForRepo` was written for this and only its own test called it, so every
    // repository silently got the global default no matter what was assigned.
    const repoId = reviews.ensureRepo(pr.owner, pr.repo);
    const record = playbooks.resolveForRepo(repoId);
    if (!record) throw new Error("no active playbook");

    const controller = new AbortController();
    try {
      const result = await reviewPullRequest({
        client,
        db,
        deps: {
          driver,
          registry: await providers.buildRegistry(),
          spans: new SpanRecorder(db),
          // Admission control across every concurrent review. Without this the daemon
          // starts every agent of every review at once and the per-agent, per-repo and
          // per-provider limits are decoration.
          acquireSlot: (slot, signal) => scheduler.acquire(slot, signal),
        },
        playbook: record.doc,
        playbookVersionId: record.id,
        linear,
        pr,
        // Registering on the RESULT would register a review that has already finished:
        // the map would always be empty at the moment a push needs to cancel something,
        // so cancel-on-push could never fire during the minutes when it matters.
        onStart: ({ reviewId }) => inFlight.set(reviewId, controller),
        signal: controller.signal,
      });
      notify("review", { reviewId: result.reviewId, state: result.state });
    } finally {
      for (const [id, c] of inFlight) if (c === controller) inFlight.delete(id);
    }
  };

  for (let i = 0; i < workerCount; i++) {
    workers.push(
      (async () => {
        while (!stopping) {
          const job = queue.claim(LEASE_MS, ["review-pr"]);
          if (!job) {
            await sleep(1000);
            continue;
          }
          // The lease is a deadline, not a reservation: once it passes another worker may
          // claim the same job even though this one is still working. Reviews routinely
          // approach the lease — a single agent has been observed running 900 seconds —
          // so without renewal a long review is re-claimed, burns an attempt each time,
          // and is eventually marked failed while it is still succeeding. `heartbeat`
          // existed for this and nothing called it.
          const renew = setInterval(() => {
            try {
              queue.heartbeat(job.id, LEASE_MS);
            } catch (err) {
              // A failed renewal is not worth killing the review over; the worst case is
              // the re-claim this exists to avoid, and the idempotency key still holds.
              logger.warn({ jobId: job.id, err }, "lease renewal failed");
            }
          }, LEASE_MS / 3);

          try {
            notify("review", { started: job.id });
            await runOne(job.payload as PullRequestRef);
            queue.complete(job.id);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error({ jobId: job.id, err: message }, "review job failed");
            queue.fail(job.id, message);
          } finally {
            clearInterval(renew);
          }
        }
      })(),
    );
  }

  // ── webhook listener ────────────────────────────────────────────────────
  let webhookServer: Server | undefined;
  let webhookPort: number | undefined;
  if (opts.webhookPort !== undefined) {
    webhookServer = createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      let raw = "";
      let tooLarge = false;
      req.on("data", (c) => {
        if (tooLarge) return;
        raw += c;
        // Refuse to buffer an unbounded body from an unverified caller. Answer before
        // destroying: dropping the connection silently looks like a network fault to
        // whoever is debugging their delivery.
        if (raw.length > 8 * 1024 * 1024) {
          tooLarge = true;
          raw = "";
          res.writeHead(413).end("payload too large");
          req.destroy();
        }
      });
      req.on("end", async () => {
        if (tooLarge) return;
        // Unconditional: the listener cannot start without a secret, so there is no
        // branch here in which verification is skipped.
        const signature = req.headers["x-hub-signature-256"] as string | undefined;
        const ok = await verifySignature(opts.webhookSecret ?? "", raw, signature);
        if (!ok) {
          logger.warn({ ip: req.socket.remoteAddress }, "rejected webhook: bad signature");
          res.writeHead(401).end("invalid signature");
          return;
        }
        try {
          const event = (req.headers["x-github-event"] as string) ?? "";
          enqueueTrigger(interpretEvent(event, JSON.parse(raw)));
          res.writeHead(202).end("accepted");
        } catch (err) {
          logger.error({ err }, "webhook handling failed");
          res.writeHead(400).end("bad payload");
        }
      });
    });
    await new Promise<void>((r) => webhookServer?.listen(opts.webhookPort, "0.0.0.0", r));
    webhookPort = (webhookServer.address() as AddressInfo).port;
  }

  // ── poller ──────────────────────────────────────────────────────────────
  let pollTimer: NodeJS.Timeout | undefined;
  if (opts.poll?.repos.length) {
    const state = newPollState();
    const tick = async () => {
      const client = GitHubClient.fromEnv();
      if (!client) return;
      for (const slug of opts.poll?.repos ?? []) {
        const [owner, repo] = slug.split("/");
        if (!owner || !repo) continue;
        try {
          const open = await client.listOpenPullRequests(owner, repo);
          const observed = await Promise.all(
            open.map(async (ref) => ({
              pr: ref,
              headSha: (await client.getPullRequest(ref)).headSha,
            })),
          );
          for (const t of diffPoll(state, observed)) enqueueTrigger(t);
        } catch (err) {
          logger.warn({ slug, err: err instanceof Error ? err.message : err }, "poll failed");
        }
      }
    };
    void tick();
    pollTimer = setInterval(() => void tick(), opts.poll.intervalMs);
  }

  // ── environment reaper ──────────────────────────────────────────────────
  // Containers and snapshot images outlive a crashed process; sweeping on an interval is
  // what stops a long-running daemon from filling the disk.
  const reaperTimer = setInterval(() => {
    // Two guards, because either alone has failed here. The age filter was passed and
    // ignored by the driver, so this swept containers of every age; and the sweep never
    // named the reviews it must not touch, so it was destroying the containers its own
    // in-flight reviews were using, every ten minutes.
    const active = db
      .prepare(
        `SELECT id FROM reviews WHERE state IN (${IN_FLIGHT_STATES.map(() => "?").join(",")})`,
      )
      .all<{ id: string }>(...IN_FLIGHT_STATES)
      .map((r) => r.id);

    void driver
      .reap({ olderThanMs: 2 * 60 * 60_000, protectReviewIds: active })
      .catch((err) => logger.warn({ err }, "reap failed"));
  }, 10 * 60_000);

  return {
    webhookPort,
    adminPort: admin?.port ?? opts.adminPort,
    adminToken,
    async stop() {
      stopping = true;
      clearInterval(reaperTimer);
      if (pollTimer) clearInterval(pollTimer);
      for (const c of inFlight.values()) c.abort();
      await new Promise<void>((r) => (webhookServer ? webhookServer.close(() => r()) : r()));
      await admin?.close();
      await Promise.allSettled(workers);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
