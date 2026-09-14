#!/usr/bin/env node
/**
 * Read-only live check of every GitHub read path, against the real API.
 *
 * The unit tests use fixtures and mocks, which prove the parsing and prove nothing about
 * whether the request shapes match what GitHub actually returns. This is the other half,
 * and it is a script rather than a test because it needs a credential and a real pull
 * request, neither of which CI has.
 *
 * Read-only by default. `--write` adds the three calls that change something —
 * `postReview`, `findPreviousComment`, `updateComment` — and removes what it created.
 *
 *   pnpm build
 *   GITHUB_TOKEN=$(gh auth token) node scripts/live-github-check.mjs <owner>/<repo>#<number>
 *
 * Add --write to also exercise post/find/update. That one creates a comment on the pull
 * request and deletes it again, including if a step fails.
 *
 * Add --write-review-state to exercise requesting changes and dismissing the block. A review
 * cannot be deleted, so that one leaves a dismissed review behind; see its section below.
 *
 * The two review-comment read paths need a pull request that actually has inline comments
 * and a reaction on one, which most do not. `--comments-from=<owner>/<repo>#<number>`
 * points those two checks somewhere else; they are read-only, so any public pull request
 * will do.
 */
import { GitHubClient } from "../packages/integrations/dist/index.js";

const target = process.argv[2] ?? "mustafarslan/maestro#1";
const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(target);
if (!m) {
  console.error(`usage: node scripts/live-github-check.mjs <owner>/<repo>#<number>`);
  process.exit(2);
}
const ref = { owner: m[1], repo: m[2], number: Number(m[3]) };

const client = GitHubClient.fromEnv();
if (!client) {
  console.error("no GitHub credential: set GITHUB_TOKEN, or run 'maestro github-app create'");
  process.exit(2);
}

let failures = 0;
const ok = (n, v) => console.log(`  ok   ${n}: ${v}`);
const bad = (n, e) => {
  failures++;
  console.log(`  FAIL ${n}: ${e?.message ?? e}`);
};
const check = async (name, fn) => {
  try {
    ok(name, await fn());
  } catch (e) {
    bad(name, e);
  }
};

console.log(`\nlive github check — ${target} (read-only)\n`);

await check("identity", () => client.identity());

let pr;
await check("getPullRequest", async () => {
  pr = await client.getPullRequest(ref);
  // Every field a review depends on, named individually: a silently-undefined baseSha
  // turns the whole incremental path into a full re-review without any error.
  const missing = ["headSha", "baseSha", "baseRef", "headRef", "title"].filter((k) => !pr[k]);
  if (missing.length) throw new Error(`fields missing from the response: ${missing.join(", ")}`);
  return `#${pr.number} base=${pr.baseRef} head=${pr.headSha.slice(0, 8)} files=${pr.changedFiles.length} lines=${pr.changedLines} fork=${pr.isFork}`;
});

await check("listOpenPullRequests", async () => {
  const open = await client.listOpenPullRequests(ref.owner, ref.repo);
  return `${open.length} open`;
});

// Both branches: a repository without the file, and a file that is really there. Only the
// second proves the base64 decode, and only the first proves absence is not an error.
await check("getBaseBranchConfig (absent)", async () => {
  const cfg = await client.getBaseBranchConfig(pr, ".maestro.does-not-exist.yaml");
  if (cfg !== null) throw new Error("a missing file did not read as null");
  return "null";
});
await check("getBaseBranchConfig (present)", async () => {
  const readme = await client.getBaseBranchConfig(pr, "README.md");
  if (!readme) throw new Error("a file that exists read as absent");
  return `${readme.length} bytes decoded`;
});

await check("filesChangedBetween", async () => {
  const files = await client.filesChangedBetween(ref, pr.baseSha, pr.headSha);
  if (files === null) throw new Error("compare returned unknown");
  return `${files.length} files`;
});

await check("findPreviousComment", async () => {
  const id = await client.findPreviousComment(pr, "<!-- maestro-review -->");
  return id === null ? "none" : `id ${id}`;
});

await check("cloneToken", async () => {
  const token = await client.cloneToken();
  return token ? `${token.length} chars` : "none";
});

/**
 * The write path, behind an explicit flag.
 *
 * Posting, finding and updating a comment is the half no fixture can cover, and it is the
 * half a review depends on: one comment per pull request, updated in place rather than
 * piled on. Everything it creates it removes again, including on failure — a test run
 * that leaves a comment behind on somebody's pull request is worse than no test run.
 *
 * Opt-in because it writes to a real repository. Nothing here calls a model.
 */
if (process.argv.includes("--write")) {
  const MARKER = "<!-- maestro-live-check -->";
  const token = await client.cloneToken();
  let commentId;

  const remove = async () => {
    if (!commentId) return;
    const res = await fetch(
      `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/comments/${commentId}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      },
    );
    console.log(
      res.ok
        ? `  ok   cleanup: deleted comment ${commentId}`
        : `  FAIL cleanup: ${res.status} — DELETE comment ${commentId} by hand`,
    );
    if (!res.ok) failures++;
  };

  console.log("\n  write path (creates a comment and deletes it again)\n");
  try {
    await check("postReview", async () => {
      const posted = await client.postReview(
        pr,
        `${MARKER}\nMaestro live check — this comment deletes itself.`,
      );
      commentId = posted.id;
      // `postReview` posts an issue comment and nothing else now: the summary must stay
      // updatable in place, and `updateComment` is the issues API. Anchored comments go
      // through `postInlineComments` separately, which this check does not exercise —
      // it would leave review threads that cannot be deleted the way a comment can.
      if (posted.mode !== "comment")
        throw new Error(`expected an issue comment, got ${posted.mode}`);
      return `id ${posted.id} as a ${posted.mode}`;
    });

    await check("findPreviousComment finds it", async () => {
      const found = await client.findPreviousComment(pr, MARKER);
      if (found !== commentId) throw new Error(`found ${found}, expected ${commentId}`);
      return `id ${found}`;
    });

    await check("updateComment edits in place", async () => {
      await client.updateComment(ref, commentId, `${MARKER}\nEdited by the live check.`);
      // Read it back: an update that silently no-ops would pass a test that only checks
      // the call did not throw, and "one comment updated in place" is the whole claim.
      const res = await fetch(
        `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/comments/${commentId}`,
        { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } },
      );
      const body = (await res.json()).body ?? "";
      if (!body.includes("Edited by the live check")) throw new Error("the edit did not land");
      // And still exactly one comment carries the marker — updating must not have posted.
      const again = await client.findPreviousComment(pr, MARKER);
      if (again !== commentId) throw new Error(`marker now matches ${again}, not ${commentId}`);
      return "edit landed, still one comment";
    });
  } finally {
    await remove();
  }
}

/**
 * The review-state path a developer profile uses, behind its own flag.
 *
 * Separate from `--write` because it cannot clean up after itself: a submitted review can be
 * dismissed but never deleted, so running this leaves one dismissed "changes requested" review
 * on the target pull request's timeline. Point it at a pull request that exists for testing.
 *
 * Either answer to the first call is informative. `requested` proves the request shape and
 * then the dismissal; `refused` is GitHub declining REQUEST_CHANGES on a pull request the
 * token's own account opened, which is the degradation `submitReviewState` promises.
 */
if (process.argv.includes("--write-review-state")) {
  console.log("\n  review-state path (leaves one dismissed review on the timeline)\n");
  let requested;
  await check("submitReviewState REQUEST_CHANGES", async () => {
    const result = await client.submitReviewState(
      pr,
      "REQUEST_CHANGES",
      "Maestro live check — this review is dismissed immediately.",
    );
    if (result.outcome === "requested") requested = result.reviewId;
    else if (result.outcome !== "refused") throw new Error(`unexpected outcome ${result.outcome}`);
    return result.outcome === "requested"
      ? `review ${result.reviewId} submitted`
      : `refused as promised: ${result.reason}`;
  });
  if (requested) {
    await check("submitReviewState COMMENT dismisses it", async () => {
      const result = await client.submitReviewState(pr, "COMMENT", "");
      if (!result.dismissed.includes(requested)) {
        throw new Error(
          `review ${requested} was not dismissed (${result.reason ?? "no reason given"}) — dismiss it by hand`,
        );
      }
      return `dismissed ${result.dismissed.join(", ")}`;
    });
  }
}

/**
 * The two read paths the finding-level feedback signal rests on.
 *
 * `postInlineComments` lists a review's comments to learn their ids, and `ingestReaction`
 * reads the reactions off one of them. Both were asserted against stubs written from what
 * the code expected, which is the half of a contract a stub cannot check. This is the
 * other half, and it found the feature not working at all: `listCommentsForReview` answers
 * with the legacy `position`-based representation, in which `line` is *always* null, so
 * every comment was anchored at line 0, matched no anchor, and had its id dropped. Both
 * halves are checked here — that the review-scoped listing omits the line, and that the
 * pull request's own listing carries it — because the first is the reason for the second
 * and a reader who only sees the second will eventually "simplify" it back.
 *
 * Read-only, and pointed at whatever `--comments-from` names, because a pull request with
 * inline comments and a reaction on one is not something the target repository is
 * guaranteed to have.
 */
const commentsArg = process.argv.find((a) => a.startsWith("--comments-from="));
const cm = /^([^/]+)\/([^#]+)#(\d+)$/.exec(commentsArg?.split("=")[1] ?? target);
if (cm) {
  const cref = { owner: cm[1], repo: cm[2], number: Number(cm[3]) };
  const token = await client.cloneToken();
  const api = async (path) => {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    });
    return { status: res.status, body: res.ok ? await res.json() : null };
  };
  const base = `/repos/${cref.owner}/${cref.repo}/pulls`;

  console.log(`\n  review comments — ${cref.owner}/${cref.repo}#${cref.number}\n`);

  const { body: allComments } = await api(`${base}/${cref.number}/comments?per_page=100`);
  // Prefer a review that left a comment somebody reacted to: an empty reaction list is a
  // valid answer and therefore checks nothing about parsing one.
  const reviewId = (
    allComments?.find((c) => c.pull_request_review_id && (c.reactions?.total_count ?? 0) > 0) ??
    allComments?.find((c) => c.pull_request_review_id)
  )?.pull_request_review_id;

  let sample;
  await check("listReviewComments carries the line", async () => {
    if (!reviewId)
      throw new Error(
        "no review here has inline comments — pass --comments-from=<owner>/<repo>#<n>",
      );
    const mine = allComments.filter((c) => c.pull_request_review_id === reviewId);
    for (const c of mine) {
      if (typeof c.id !== "number") throw new Error(`comment id is ${typeof c.id}, not a number`);
      if (typeof c.path !== "string") throw new Error(`comment ${c.id} has no path`);
      // The field Maestro anchors on. Null in both is what makes an id unusable.
      if (c.line == null && c.original_line == null)
        throw new Error(`comment ${c.id} has neither line nor original_line`);
    }
    sample = mine.find((c) => (c.reactions?.total_count ?? 0) > 0) ?? mine[0];
    const outdated = mine.filter((c) => c.line == null).length;
    return `review ${reviewId}: ${mine.length} comment(s), ${outdated} outdated (original_line carries those)`;
  });

  // Why the listing above is the pull request's rather than the review's. This endpoint
  // looks like the obvious one and is the one that was used; it answers with the legacy
  // position-based shape and no line at all, which is what made the whole attribution a
  // no-op. Asserted, so that "simplify this back" fails instead of shipping.
  await check("listCommentsForReview does NOT, whatever is asked for", async () => {
    if (!reviewId) throw new Error("no review to check");
    const { body: scoped } = await api(
      `${base}/${cref.number}/reviews/${reviewId}/comments?per_page=100`,
    );
    const withLine = (scoped ?? []).filter((c) => c.line != null || c.original_line != null);
    if (withLine.length)
      throw new Error(
        `${withLine.length} of ${scoped.length} carried a line — GitHub may have changed this, ` +
          "and postInlineComments could go back to one request",
      );
    return `${scoped.length} comment(s), all line=null and original_line=null`;
  });

  await check("listCommentReactions (inline)", async () => {
    if (!sample) throw new Error("no comment to read reactions from");
    // Maestro's own method, so the endpoint it picks for `kind: "inline"` is what runs.
    const rx = await client.listCommentReactions(cref, sample.id, "inline");
    // Shape, not count: a comment with no reactions is a valid answer and an empty list
    // must not read as a failure.
    for (const r of rx)
      if (typeof r.content !== "string") throw new Error("a reaction came back with no content");
    const seen = rx.map((r) => r.content).join(", ");
    return `comment ${sample.id}: ${rx.length} reaction(s)${seen ? ` — ${seen}` : ""}`;
  });

  // Thread resolution, which REST does not expose at all — `isResolved` exists only on
  // GraphQL's `PullRequestReviewThread`. This is the `resolved` feedback signal: declared
  // in `FeedbackSignal`, honoured by `settleStatus`, and written by nothing until now.
  await check("resolvedThreadCommentIds", async () => {
    const resolved = await client.resolvedThreadCommentIds(cref);
    for (const r of resolved) {
      if (typeof r.commentId !== "number")
        throw new Error(`a resolved thread came back with commentId ${typeof r.commentId}`);
    }
    // The ids must be ones the REST listing also knows, or nothing can be matched to a
    // finding: `posted_comment_id` is written from REST and read back against these.
    const known = new Set((allComments ?? []).map((c) => c.id));
    const stray = resolved.filter((r) => !known.has(r.commentId));
    if (stray.length)
      throw new Error(`${stray.length} resolved thread id(s) are not REST comment ids`);
    return resolved.length
      ? `${resolved.length} resolved — ${resolved.map((r) => `${r.commentId} by ${r.by ?? "?"}`).join(", ")}`
      : "none resolved on this pull request";
  });

  // The control, as in the Linear check: without it "no error" cannot be told apart from
  // "the request was never made". A review id that cannot exist has to be refused.
  await check("control: a review id that does not exist is refused", async () => {
    const { status } = await api(`${base}/${cref.number}/reviews/1/comments?per_page=1`);
    if (status !== 404) throw new Error(`expected 404, got ${status} — this check proves nothing`);
    return "404, so the endpoint really was reached";
  });
}

console.log(failures ? `\n${failures} failed\n` : "\nall checked paths verified live\n");
process.exit(failures ? 1 : 0);
