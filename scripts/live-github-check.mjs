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
      // No inline anchors passed, so this must take the issue-comment path rather than
      // the review path: a review with no comments would still show as a review.
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

console.log(failures ? `\n${failures} failed\n` : "\nall checked paths verified live\n");
process.exit(failures ? 1 : 0);
