import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  logger,
  planIncremental,
  ReviewStore,
  type SpanRecorder,
  type SqlDatabase,
} from "@maestro/core";
import {
  type EngineDeps,
  type ReviewOutcome,
  ReviewRecorder,
  renderReview,
  runReview,
} from "@maestro/engine";
import type { EnvSpec, PlaybookDocument } from "@maestro/playbook";
import {
  checkoutPullRequest,
  type GitHubClient,
  type PullRequestContext,
  type PullRequestRef,
} from "./github.js";
import { type LinearClient, resolveIssueForPullRequest } from "./linear.js";

/** Lets Maestro find and update its own previous comment instead of piling on. */
export const COMMENT_MARKER = "<!-- maestro-review -->";

export interface ReviewPullRequestOptions {
  client: GitHubClient;
  db: SqlDatabase;
  deps: Omit<EngineDeps, "db">;
  spans?: SpanRecorder;
  playbook: PlaybookDocument;
  playbookVersionId: string;
  pr: PullRequestRef;
  /** Skip posting; used by `--dry-run` and by the eval runner. */
  dryRun?: boolean;
  /** Re-review a head SHA that has already been reviewed (e.g. after a playbook change). */
  force?: boolean;
  /** Set false to always review the full diff instead of the delta since the last round. */
  incremental?: boolean;
  /** Linear issue lookup. Absent means reviews run without ticket context. */
  linear?: LinearClient;
  /**
   * Fired as soon as the review row exists, before any long-running work.
   *
   * The caller cannot otherwise register its AbortController anywhere useful: the review
   * id is not known until this function creates it, and waiting for the return value
   * means only registering a review that has already finished.
   */
  onStart?: (info: { reviewId: string; headSha: string; prNumber: number }) => void;
  signal?: AbortSignal;
}

export interface ReviewPullRequestResult {
  reviewId: string;
  state: string;
  outcome?: ReviewOutcome;
  markdown?: string;
  posted?: { id: number; mode: string };
  skipped?: string;
}

/**
 * Reviews one pull request end to end.
 *
 * Ordering matters here: the review row is created (and older ones superseded) before any
 * work starts, so a second delivery for the same SHA is a no-op and a push mid-review
 * makes the in-flight result unpostable rather than stale-but-published.
 */
export async function reviewPullRequest(
  opts: ReviewPullRequestOptions,
): Promise<ReviewPullRequestResult> {
  const { client, db, playbook } = opts;
  const reviews = new ReviewStore(db);
  const pr = await client.getPullRequest(opts.pr);
  const log = logger.child({
    pr: `${pr.owner}/${pr.repo}#${pr.number}`,
    headSha: pr.headSha.slice(0, 8),
  });

  const repoId = reviews.ensureRepo(pr.owner, pr.repo);
  const { id: reviewId, created } = reviews.create({
    repoOwner: pr.owner,
    repoName: pr.repo,
    prNumber: pr.number,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    baseRef: pr.baseRef,
    title: pr.title,
    author: pr.author,
    isFork: pr.isFork,
    playbookVersionId: opts.playbookVersionId,
  });

  if (!created && !opts.force) {
    // The idempotency key already covers this exact SHA: a redelivered webhook, or the
    // poller racing the webhook, must not start a second review.
    const existing = reviews.get(reviewId);
    if (existing && !["failed", "cancelled"].includes(existing.state)) {
      log.info({ reviewId, state: existing.state }, "review already exists for this head sha");
      return { reviewId, state: existing.state, skipped: "already reviewed at this head sha" };
    }
  }

  // Before anything slow: the caller needs the id to be able to cancel this review.
  opts.onStart?.({ reviewId, headSha: pr.headSha, prNumber: pr.number });

  const superseded = reviews.supersedeOlder(repoId, pr.number, pr.headSha);
  if (superseded) log.info({ superseded }, "superseded older reviews for this pull request");

  // Repeated pushes to the same pull request should get cheaper and stay readable:
  // review the delta since the last reviewed head, and carry forward anything that was
  // reported and never addressed so it does not silently vanish between rounds.
  const plan = planIncremental(db, {
    repoId,
    prNumber: pr.number,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    allowIncremental: opts.incremental !== false,
  });
  if (plan.incremental) {
    log.info(
      { since: plan.previousHeadSha?.slice(0, 8), carried: plan.carried.length },
      "incremental review",
    );
  }

  const envSpec = resolveEnvSpec(playbook.envSpec, pr);
  const workdir = mkdtempSync(join(tmpdir(), `maestro-${pr.repo}-`));

  try {
    reviews.setState(reviewId, "preparing");
    const token = await client.cloneToken();
    await checkoutPullRequest(pr, workdir, token, plan.previousHeadSha);

    // The ticket is the independent record of what was asked for; the PR description is
    // the author's own account of it. The product agent needs the former to judge the
    // latter, so it is fetched here — by the orchestrator, never by an agent, which has
    // no credentials and no network by design.
    const issue = await resolveIssueForPullRequest(opts.linear, {
      branch: pr.headRef,
      title: pr.title,
      body: pr.body,
    });

    const outcome = await runReview(
      { ...opts.deps, db },
      {
        reviewId,
        // Real repo identity, so the scheduler's per-repo limit stops one busy repo
        // from starving the others rather than being a per-review no-op.
        repoId,
        playbook,
        sourcePath: workdir,
        baseRef: plan.baseRef,
        changedFiles: pr.changedFiles,
        changedLines: pr.changedLines,
        context: {
          pr: { number: pr.number, title: pr.title, description: pr.body, author: pr.author },
          repo: { owner: pr.owner, name: pr.repo, defaultBranch: pr.baseRef },
          diff: { changedFiles: pr.changedFiles, changedLines: pr.changedLines },
          linear: issue && {
            identifier: issue.identifier,
            title: issue.title,
            description: issue.description,
            acceptanceCriteria: issue.acceptanceCriteria,
          },
          carriedFindings: plan.carried.length
            ? plan.carried.map(
                (c) =>
                  `${c.severity} ${c.category} at ${c.file ?? "PR"}:${c.lineStart ?? "?"} - ${c.title}`,
              )
            : undefined,
        },
        envSpec,
        signal: opts.signal,
      },
    );

    new ReviewRecorder(db).recordOutcome(reviewId, outcome);

    // Re-read before posting: a push during the run may have superseded this result,
    // and publishing a review for a SHA nobody is looking at any more is worse than
    // publishing nothing.
    const current = reviews.get(reviewId);
    if (current?.state === "superseded") {
      log.info({ reviewId }, "not posting: superseded by a newer push");
      return { reviewId, state: "superseded", outcome, skipped: "superseded before posting" };
    }

    const markdown = `${COMMENT_MARKER}\n${renderReview(outcome, {
      title: `Maestro review — ${pr.title}`,
    })}`;

    if (opts.dryRun) {
      reviews.setState(reviewId, outcome.state, { costCents: outcome.costCents });
      return { reviewId, state: outcome.state, outcome, markdown };
    }

    reviews.setState(reviewId, "posting");
    const previous = await client.findPreviousComment(pr, COMMENT_MARKER);
    let posted: { id: number; mode: string };
    if (previous) {
      // One comment per PR that gets updated, rather than a new one per push.
      await client.updateComment(pr, previous, markdown);
      posted = { id: previous, mode: "updated" };
    } else {
      posted = await client.postReview(pr, markdown, []);
    }

    // Without the comment id, a later reaction cannot be matched back to the findings
    // it was reacting to, and the whole precision signal is lost.
    db.prepare(
      "UPDATE findings SET posted_comment_id=?, status='posted' WHERE review_id=? AND status='open'",
    ).run(String(posted.id), reviewId);

    reviews.setState(reviewId, outcome.state, {
      error: outcome.error,
      costCents: outcome.costCents,
    });
    log.info({ reviewId, posted }, "review posted");
    return { reviewId, state: outcome.state, outcome, markdown, posted };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reviews.setState(reviewId, "failed", { error: message });
    log.error({ err: message }, "pull request review failed");
    throw err;
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

/**
 * Fork pull requests carry code from outside the organisation. They are downgraded to
 * `untrusted`, which means no command execution at all — a reviewer reading code is
 * useful; a reviewer running a stranger's build script is a supply-chain incident.
 */
export function resolveEnvSpec(base: EnvSpec, pr: PullRequestContext): EnvSpec {
  if (!pr.isFork) return base;
  return {
    ...base,
    trust: "untrusted",
    setup: [],
    allowedCommands: [],
    egressAllowlist: [],
  };
}
