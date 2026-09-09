import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CarriedFinding,
  logger,
  planIncremental,
  ReviewStore,
  type SpanRecorder,
  type SqlDatabase,
} from "@maestro/core";
import {
  anchorKey,
  type EngineDeps,
  inlineComments,
  type ReviewOutcome,
  ReviewRecorder,
  renderReview,
  runReview,
} from "@maestro/engine";
import type { EnvSpec, PlaybookDocument } from "@maestro/playbook";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
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

  // A repository may narrow its own sandbox from its base branch, never widen it.
  // `getBaseBranchConfig` existed for this and nothing called it, so `.maestro.yaml` was
  // never read at all: the safety property held trivially while the capability did not
  // exist, and STATUS recorded it as verified.
  const repoOverride = await readRepoConfig(client, pr);
  const envSpec = resolveEnvSpec(narrowEnvSpec(playbook.envSpec, repoOverride, log), pr);
  const workdir = mkdtempSync(join(tmpdir(), `maestro-${pr.repo}-`));

  try {
    reviews.setState(reviewId, "preparing");
    const token = await client.cloneToken();
    const checkout = await checkoutPullRequest(pr, workdir, token, plan.previousHeadSha);

    // The ticket is the independent record of what was asked for; the PR description is
    // the author's own account of it. The product agent needs the former to judge the
    // latter, so it is fetched here — by the orchestrator, never by an agent, which has
    // no credentials and no network by design.
    const issue = await resolveIssueForPullRequest(opts.linear, {
      branch: pr.headRef,
      title: pr.title,
      body: pr.body,
    });
    // Kept, not just rendered. Without this the criteria the product agent judged
    // against existed only inside a prompt that is discarded when the review ends.
    if (issue) reviews.setLinearIssue(reviewId, issue);

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
        // The agents' `git_diff` falls back to a two-point comparison when the fork
        // point is missing, and both halves of that fallback exit 0 — so without this
        // the review would read the wrong diff and say nothing.
        diffDegraded: !checkout.mergeBase,
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
    // An aborted review must not post either. Cancellation existed to stop a review
    // "finishing a comment nobody will read" — but the engine treats an abort as every
    // agent being skipped and still returns a completed review, so the empty comment was
    // posted to the closed pull request anyway. Guarding only on `superseded` covered the
    // push case and not the close case.
    if (opts.signal?.aborted) {
      reviews.setState(reviewId, "cancelled");
      log.info({ reviewId }, "not posting: review was cancelled");
      return { reviewId, state: "cancelled", outcome, skipped: "cancelled before posting" };
    }

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
      posted = await client.postReview(pr, markdown);
    }

    const inlinePosted = await postAnchoredComments(client, pr, outcome, playbook, plan.carried);

    // Without the comment id, a later reaction cannot be matched back to the findings
    // it was reacting to, and the whole precision signal is lost.
    db.prepare(
      "UPDATE findings SET posted_comment_id=?, status='posted' WHERE review_id=? AND status='open'",
    ).run(String(posted.id), reviewId);

    reviews.setState(reviewId, outcome.state, {
      error: outcome.error,
      costCents: outcome.costCents,
    });
    log.info({ reviewId, posted, inlinePosted }, "review posted");
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

/** The subset of an env spec a repository may state for itself. */
const RepoConfigSchema = z.object({
  envSpec: z
    .object({
      cpus: z.number().positive().optional(),
      timeouts: z
        .object({
          prepareSec: z.number().positive().optional(),
          analyzeSec: z.number().positive().optional(),
          commandSec: z.number().positive().optional(),
        })
        .optional(),
      allowedCommands: z.array(z.string()).optional(),
      egressAllowlist: z.array(z.string()).optional(),
    })
    .optional(),
});

type RepoConfig = z.infer<typeof RepoConfigSchema>;

async function readRepoConfig(
  client: GitHubClient,
  pr: PullRequestContext,
): Promise<RepoConfig | undefined> {
  const raw = await client.getBaseBranchConfig(pr).catch(() => null);
  if (!raw) return undefined;
  const parsed = RepoConfigSchema.safeParse(parseYaml(raw));
  if (!parsed.success) {
    logger.warn({ pr: pr.number }, ".maestro.yaml is not valid; ignoring it");
    return undefined;
  }
  return parsed.data;
}

/**
 * Applies a repository's own config, in the narrowing direction only.
 *
 * Reading from the base branch stops a pull request altering the environment it will be
 * analysed in, but that alone is not enough: anyone with write access could still raise
 * their own limits, and a compromised branch could widen the egress allowlist. So every
 * field is intersected rather than replaced. A repo may ask for less CPU, a shorter
 * timeout, fewer commands and fewer egress hosts; asking for more has no effect.
 */
export function narrowEnvSpec(
  base: EnvSpec,
  override: RepoConfig | undefined,
  log: { info: (obj: object, msg: string) => void },
): EnvSpec {
  const spec = override?.envSpec;
  if (!spec) return base;

  const narrowed: EnvSpec = {
    ...base,
    cpus: spec.cpus !== undefined ? Math.min(base.cpus, spec.cpus) : base.cpus,
    timeouts: {
      prepareSec: Math.min(
        base.timeouts.prepareSec,
        spec.timeouts?.prepareSec ?? Number.MAX_SAFE_INTEGER,
      ),
      analyzeSec: Math.min(
        base.timeouts.analyzeSec,
        spec.timeouts?.analyzeSec ?? Number.MAX_SAFE_INTEGER,
      ),
      commandSec: Math.min(
        base.timeouts.commandSec,
        spec.timeouts?.commandSec ?? Number.MAX_SAFE_INTEGER,
      ),
    },
    // Intersections: an entry the playbook did not already permit cannot be added here.
    allowedCommands: spec.allowedCommands
      ? base.allowedCommands.filter((c) => spec.allowedCommands?.includes(c))
      : base.allowedCommands,
    egressAllowlist: spec.egressAllowlist
      ? base.egressAllowlist.filter((h) => spec.egressAllowlist?.includes(h))
      : base.egressAllowlist,
  };

  log.info({ from: ".maestro.yaml" }, "applied repository config, narrowing only");
  return narrowed;
}

/**
 * Leaves anchored comments on the lines the findings point at.
 *
 * Phase 3 asks for "inline comments where line anchors are valid" and nothing built it:
 * `postReview` accepted a list and every caller passed `[]`, so the feature was plumbing
 * with nothing in it.
 *
 * Separate from `reviewPullRequest` so the three decisions here can be tested without an
 * engine, a container or a clone — which is the only reason they were testable at all.
 */
export async function postAnchoredComments(
  client: Pick<GitHubClient, "postInlineComments">,
  pr: PullRequestContext,
  outcome: ReviewOutcome,
  playbook: PlaybookDocument,
  carried: CarriedFinding[],
): Promise<number> {
  // Anchors an earlier round already left. Without this a carried-forward finding posts
  // the same comment again at the same place on every push.
  const already = new Set(carried.map((c) => anchorKey(c.file ?? "", c.lineStart ?? undefined)));

  // Filtered against the diff BEFORE posting: `createReview` rejects the entire review
  // over one anchor outside it, so a single finding pointing at an unchanged line would
  // otherwise cost every other comment.
  const anchors = inlineComments(outcome.triage?.posted ?? [], pr.commentable ?? new Map(), {
    cap: playbook.triage.maxInlineComments,
    already,
  });

  return client.postInlineComments(pr, anchors);
}
