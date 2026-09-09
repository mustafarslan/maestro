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

/**
 * Who may spend money by asking for a review.
 *
 * GitHub's `author_association` on the delivery, which is the repository's own statement
 * about the commenter and not something the commenter writes. OWNER, MEMBER and
 * COLLABORATOR have write access; everyone else — CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR,
 * NONE — can comment on a public repository without being able to merge anything, and a
 * review they trigger starts containers and bills model calls.
 *
 * Automatic triggers are unaffected: those come from the pull request's own lifecycle.
 */
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * What asked for a review.
 *
 * `lifecycle` is the pull request itself — opened, pushed to, marked ready; `comment` is
 * a person saying so. They are gated differently, and matching on the reason string to
 * tell them apart would be a trap for whoever next reworded it.
 *
 * A comment carries the id of the comment that asked. Redelivery of the same comment
 * repeats the id, so it stays idempotent; a second, genuinely new request gets a new one
 * and runs. Without it every request after the first on a given pull request collides on
 * the same dedupe key and is dropped for ever.
 */
export type ReviewSource = { source: "lifecycle" } | { source: "comment"; commentId: number };

export type ReviewTrigger =
  | ({
      kind: "review";
      pr: PullRequestRef;
      headSha: string;
      reason: string;
    } & ReviewSource)
  | { kind: "cancel"; pr: PullRequestRef; staleSha: string; reason: string }
  | { kind: "feedback"; commentId: number; reaction: string; actor?: string; reason: string }
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
  comment?: { body?: string; id?: number };
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
        return {
          kind: "review",
          pr: ref,
          headSha,
          reason: `pull_request.${body.action}`,
          source: "lifecycle",
        };
      case "synchronize":
        // A new push invalidates the in-flight review for the previous SHA. Both the
        // cancel and the new review are needed: the stale one is holding a container.
        return {
          kind: "review",
          pr: ref,
          headSha,
          reason: "pull_request.synchronize",
          source: "lifecycle",
        };
      // Closing a pull request, or sending it back to draft, means the review in flight
      // is producing a comment nobody will read while holding three containers for
      // several more minutes. `cancel` was declared in this union for exactly that and
      // nothing ever constructed it.
      case "closed":
      case "converted_to_draft":
        return {
          kind: "cancel",
          pr: ref,
          staleSha: headSha,
          reason: `pull_request.${body.action}`,
        };
      default:
        return { kind: "ignore", reason: `pull_request.${body.action} is not actionable` };
    }
  }

  if (event === "issue_comment" && body.action === "created") {
    const text = body.comment?.body ?? "";
    // Both spellings. `@maestro review` is what people expect, because that is how
    // `@claude review` works on GitHub; `/maestro review` reads as a bot command. There
    // is no reason to make someone learn which one this tool chose.
    if (/^\s*[/@]maestro\s+review\b/im.test(text)) {
      const number = (payload as { issue?: { number?: number } }).issue?.number;
      if (!number) return { kind: "ignore", reason: "comment is not on a pull request" };

      // A comment is anyone's to write on a public repository, and a review starts
      // containers and spends money on model calls. GitHub states the commenter's
      // relationship to the repository on the delivery itself, which is the only
      // trustworthy signal available here — the comment body certainly is not.
      const association = (payload as { comment?: { author_association?: string } }).comment
        ?.author_association;
      if (!TRUSTED_ASSOCIATIONS.has(association ?? "")) {
        return {
          kind: "ignore",
          reason: `review requested by ${association ?? "an unknown"} association, which cannot spend`,
        };
      }

      const commentId = (payload as { comment?: { id?: number } }).comment?.id;
      if (!commentId) return { kind: "ignore", reason: "comment has no id to deduplicate on" };

      return {
        kind: "review",
        pr: { owner, repo, number },
        // Unknown here, and deliberately not guessed: the worker resolves the current
        // head when it runs, which is what the requester meant by "review it".
        headSha: "",
        reason: "requested by a maestro review comment",
        source: "comment",
        commentId,
      };
    }
    return { kind: "ignore", reason: "comment is not a maestro command" };
  }

  // Reactions on Maestro's own comment are the feedback signal precision is measured
  // from; they are not review triggers.
  if (event === "reaction" && body.action === "created") {
    const reaction = (payload as { reaction?: { content?: string; user?: { login?: string } } })
      .reaction;
    const comment = (payload as { comment?: { id?: number } }).comment;
    if (reaction?.content && comment?.id) {
      return {
        kind: "feedback",
        commentId: comment.id,
        reaction: reaction.content,
        actor: reaction.user?.login,
        reason: `reaction ${reaction.content}`,
      };
    }
    return { kind: "ignore", reason: "reaction without a comment" };
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
      // The poller observes the pull request's own state, so it is a lifecycle trigger
      // and is gated with the rest of them. Someone who turns automatic reviews off
      // would be surprised to find polling still starting them.
      source: "lifecycle",
    });
  }

  // Forget closed PRs so the map does not grow without bound in a long-lived daemon.
  for (const key of [...state.seen.keys()]) {
    if (!live.has(key)) state.seen.delete(key);
  }

  logger.debug({ triggers: triggers.length, tracked: state.seen.size }, "poll diff");
  return triggers;
}
