import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { JobQueue, logger, ReviewStore, SpanRecorder, type SqlDatabase } from "@maestro/core";
import {
  diffPoll,
  GitHubClient,
  interpretEvent,
  newPollState,
  type PullRequestRef,
  type ReviewTrigger,
  reviewPullRequest,
  verifySignature,
} from "@maestro/integrations";
import { ProviderConfigStore } from "@maestro/llm";
import { PlaybookStore } from "@maestro/playbook";
import { DockerSandboxDriver } from "@maestro/sandbox";
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
export async function startDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
  const { db } = opts;
  const queue = new JobQueue(db, `daemon_${process.pid}`);
  const reviews = new ReviewStore(db);
  const playbooks = new PlaybookStore(db);
  const providers = new ProviderConfigStore(db);
  providers.ensureDefaults();
  const driver = new DockerSandboxDriver();
  const scheduler = new Scheduler(opts.limits ?? DEFAULT_LIMITS);
  const adminToken = opts.adminToken ?? randomBytes(24).toString("hex");

  const inFlight = new Map<string, AbortController>();
  let stopping = false;

  /** Enqueue rather than review inline: the HTTP handler must return immediately. */
  const enqueueTrigger = (t: ReviewTrigger): void => {
    if (t.kind !== "review") {
      logger.debug({ reason: t.reason }, "trigger ignored");
      return;
    }
    // The dedupe key is the idempotency key: webhook redelivery and the poller racing
    // the webhook both collapse to one job.
    const key = `${t.pr.owner}/${t.pr.repo}#${t.pr.number}@${t.headSha || "latest"}`;
    const id = queue.enqueue({ kind: "review-pr", payload: t.pr, dedupeKey: key });
    logger.info({ key, reason: t.reason, enqueued: Boolean(id) }, "review trigger");

    // A new head SHA makes any in-flight review of this PR unpostable; cancel it so it
    // stops holding a container and a scheduler slot.
    for (const [reviewId, controller] of inFlight) {
      const meta = reviews.get(reviewId);
      if (meta && meta.pr_number === t.pr.number && meta.head_sha !== t.headSha) {
        logger.info({ reviewId }, "cancelling superseded in-flight review");
        controller.abort();
      }
    }
  };

  // ── worker loop ─────────────────────────────────────────────────────────
  const workers: Promise<void>[] = [];
  const workerCount = opts.concurrentReviews ?? 3;

  const runOne = async (pr: PullRequestRef): Promise<void> => {
    const client = GitHubClient.fromEnv();
    if (!client) throw new Error("no GitHub credential configured");
    const record = playbooks.getActive("default");
    if (!record) throw new Error("no active playbook");

    const controller = new AbortController();
    try {
      const result = await reviewPullRequest({
        client,
        db,
        deps: { driver, registry: await providers.buildRegistry(), spans: new SpanRecorder(db) },
        playbook: record.doc,
        playbookVersionId: record.id,
        pr,
        signal: controller.signal,
      });
      if (result.reviewId) inFlight.set(result.reviewId, controller);
    } finally {
      for (const [id, c] of inFlight) if (c === controller) inFlight.delete(id);
    }
  };

  for (let i = 0; i < workerCount; i++) {
    workers.push(
      (async () => {
        while (!stopping) {
          const job = queue.claim(15 * 60_000, ["review-pr"]);
          if (!job) {
            await sleep(1000);
            continue;
          }
          try {
            await runOne(job.payload as PullRequestRef);
            queue.complete(job.id);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error({ jobId: job.id, err: message }, "review job failed");
            queue.fail(job.id, message);
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
      req.on("data", (c) => {
        raw += c;
        // Refuse to buffer an unbounded body from an unauthenticated caller.
        if (raw.length > 8 * 1024 * 1024) req.destroy();
      });
      req.on("end", async () => {
        const signature = req.headers["x-hub-signature-256"] as string | undefined;
        if (opts.webhookSecret) {
          const ok = await verifySignature(opts.webhookSecret, raw, signature);
          if (!ok) {
            logger.warn({ ip: req.socket.remoteAddress }, "rejected webhook: bad signature");
            res.writeHead(401).end("invalid signature");
            return;
          }
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
    if (!opts.webhookSecret) {
      logger.warn("webhook listener has NO secret configured; every delivery will be accepted");
    }
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
    void driver
      .reap({ olderThanMs: 2 * 60 * 60_000 })
      .catch((err) => logger.warn({ err }, "reap failed"));
  }, 10 * 60_000);

  return {
    webhookPort,
    adminPort: opts.adminPort,
    adminToken,
    async stop() {
      stopping = true;
      clearInterval(reaperTimer);
      if (pollTimer) clearInterval(pollTimer);
      for (const c of inFlight.values()) c.abort();
      await new Promise<void>((r) => (webhookServer ? webhookServer.close(() => r()) : r()));
      await Promise.allSettled(workers);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
