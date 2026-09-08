import { logger } from "@maestro/core";
import { verify } from "@octokit/webhooks-methods";
import type { PullRequestRef } from "./github.js";

/**
 * Webhook handling.
 *
 * Signature verification is not optional: this endpoint must be reachable by GitHub, so
 * it is the one part of Maestro exposed to the internet, and an unsigned payload is an
 * attacker asking us to review a repository of their choosing.
 */

export type ReviewTrigger =
  | { kind: "review"; pr: PullRequestRef; headSha: string; reason: string }
  | { kind: "cancel"; pr: PullRequestRef; staleSha: string; reason: string }
  | { kind: "ignore"; reason: string };

interface PullRequestEvent {
  action?: string;
  number?: number;
  pull_request?: {
    number: number;
    draft?: boolean;
    head?: { sha?: string };
    before?: string;
    user?: { login?: string };
  };
  before?: string;
  repository?: { name?: string; owner?: { login?: string } };
  comment?: { body?: string };
}

export async function verifySignature(
  secret: string,
  rawBody: string,
  signature: string | undefined,
): Promise<boolean> {
  if (!signature) return false;
  try {
    return await verify(secret, rawBody, signature);
  } catch {
    return false;
  }
}

/** Maps a webhook delivery to an action. Unknown events are ignored, never guessed at. */
export function interpretEvent(event: string, payload: unknown): ReviewTrigger {
  const body = payload as PullRequestEvent;
  const owner = body.repository?.owner?.login;
  const repo = body.repository?.name;

  if (!owner || !repo) return { kind: "ignore", reason: "payload has no repository" };

  if (event === "pull_request") {
    const pr = body.pull_request;
    const number = pr?.number ?? body.number;
    const headSha = pr?.head?.sha;
    if (!number || !headSha) return { kind: "ignore", reason: "payload has no pull request head" };

    const ref: PullRequestRef = { owner, repo, number };

    switch (body.action) {
      case "opened":
      case "reopened":
      case "ready_for_review":
        if (pr?.draft) return { kind: "ignore", reason: "pull request is a draft" };
        return { kind: "review", pr: ref, headSha, reason: `pull_request.${body.action}` };
      case "synchronize":
        // A new push invalidates the in-flight review for the previous SHA. Both the
        // cancel and the new review are needed: the stale one is holding a container.
        return { kind: "review", pr: ref, headSha, reason: "pull_request.synchronize" };
      default:
        return { kind: "ignore", reason: `pull_request.${body.action} is not actionable` };
    }
  }

  if (event === "issue_comment" && body.action === "created") {
    const text = body.comment?.body ?? "";
    if (/^\s*\/maestro\s+review\b/im.test(text)) {
      const number = (payload as { issue?: { number?: number } }).issue?.number;
      if (!number) return { kind: "ignore", reason: "comment is not on a pull request" };
      return {
        kind: "review",
        pr: { owner, repo, number },
        headSha: "",
        reason: "requested by /maestro review",
      };
    }
    return { kind: "ignore", reason: "comment is not a maestro command" };
  }

  if (event === "ping") return { kind: "ignore", reason: "ping" };
  return { kind: "ignore", reason: `event '${event}' is not handled` };
}

/**
 * Poll mode.
 *
 * Webhooks need a public URL, which a laptop behind NAT does not have. Polling makes
 * Maestro work with zero networking setup; the same idempotency key covers both paths,
 * so running them together cannot double-review.
 */
export interface PollState {
  /** Last head SHA seen per `owner/repo#number`. */
  seen: Map<string, string>;
}

export function newPollState(): PollState {
  return { seen: new Map() };
}

export function pollKey(pr: PullRequestRef): string {
  return `${pr.owner}/${pr.repo}#${pr.number}`;
}

export function diffPoll(
  state: PollState,
  observed: { pr: PullRequestRef; headSha: string }[],
): ReviewTrigger[] {
  const triggers: ReviewTrigger[] = [];
  const live = new Set<string>();

  for (const { pr, headSha } of observed) {
    const key = pollKey(pr);
    live.add(key);
    const previous = state.seen.get(key);
    if (previous === headSha) continue;
    state.seen.set(key, headSha);
    triggers.push({
      kind: "review",
      pr,
      headSha,
      reason: previous ? "poll: new head sha" : "poll: new pull request",
    });
  }

  // Forget closed PRs so the map does not grow without bound in a long-lived daemon.
  for (const key of [...state.seen.keys()]) {
    if (!live.has(key)) state.seen.delete(key);
  }

  logger.debug({ triggers: triggers.length, tracked: state.seen.size }, "poll diff");
  return triggers;
}
