#!/usr/bin/env node
/**
 * Read-only live check of every GitHub read path, against the real API.
 *
 * The unit tests use fixtures and mocks, which prove the parsing and prove nothing about
 * whether the request shapes match what GitHub actually returns. This is the other half,
 * and it is a script rather than a test because it needs a credential and a real pull
 * request, neither of which CI has.
 *
 * It makes no writes: no comment is posted, nothing is created. The one thing it cannot
 * cover is `postReview`/`updateComment`, which by definition change something.
 *
 *   pnpm build
 *   GITHUB_TOKEN=$(gh auth token) node scripts/live-github-check.mjs <owner>/<repo>#<number>
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

console.log(failures ? `\n${failures} failed\n` : "\nall read paths verified live\n");
process.exit(failures ? 1 : 0);
