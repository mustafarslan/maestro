import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkoutPullRequest, type PullRequestContext } from "./github.js";
import { materialiseBaseline } from "./review-pr.js";

const exec = promisify(execFile);

/**
 * Real git, because the defect was invisible to anything less.
 *
 * The agents' `git_diff` runs `base...HEAD` and falls back to `base HEAD` when the fork
 * point is not in the clone. The clone is shallow, so on a branch that is more than the
 * fetch depth behind its base the fallback fires — and a two-point comparison against the
 * *current tip* of the base branch presents everything that landed there since the fork as
 * this pull request's work, inverted. Both halves of the `||` exit 0, so nothing said so.
 */
describe("the fork point is in the clone", () => {
  let root: string;
  let bare: string;
  let headSha: string;
  let baseSha: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "maestro-checkout-"));
    const origin = join(root, "origin");
    const git = (args: string[], cwd = origin) => exec("git", ["-C", cwd, ...args]);

    await exec("git", ["init", "--quiet", "-b", "main", origin]);
    await git(["config", "user.email", "t@example.com"]);
    await git(["config", "user.name", "Test"]);
    writeFileSync(join(origin, "shared.txt"), "one\n");
    await git(["add", "."]);
    await git(["commit", "--quiet", "-m", "fork point"]);

    // A one-line branch...
    await git(["checkout", "--quiet", "-b", "feature"]);
    writeFileSync(join(origin, "feature.txt"), "the only change\n");
    await git(["add", "."]);
    await git(["commit", "--quiet", "-m", "the change under review"]);
    headSha = (await git(["rev-parse", "feature"])).stdout.trim();

    // ...and a base branch that has moved well past the default fetch depth since.
    await git(["checkout", "--quiet", "main"]);
    for (let i = 0; i < 60; i++) {
      writeFileSync(join(origin, "shared.txt"), `one\n${"x\n".repeat(i + 1)}`);
      await git(["commit", "--quiet", "-am", `unrelated ${i}`]);
    }
    baseSha = (await git(["rev-parse", "main"])).stdout.trim();

    bare = join(root, "bare.git");
    await exec("git", ["init", "--quiet", "--bare", bare]);
    await git(["push", "--quiet", bare, "--all"]);
  }, 60_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const pr = (): PullRequestContext =>
    ({
      owner: "o",
      repo: "r",
      number: 1,
      headSha,
      baseSha,
      cloneUrl: bare,
    }) as unknown as PullRequestContext;

  it("reports the fork point as found, and the diff is only the change", async () => {
    const dir = join(root, "work");
    const result = await checkoutPullRequest(pr(), dir);
    expect(result.mergeBase).toBe(true);

    // The assertion that matters: what an agent actually reads. Before deepening, this
    // said "1 file changed, 1 insertion" plus sixty deletions from a file the pull
    // request never touched.
    const { stdout } = await exec("git", ["-C", dir, "diff", "--stat", `${baseSha}...HEAD`]);
    expect(stdout).toContain("feature.txt");
    expect(stdout).not.toContain("shared.txt");
  }, 60_000);
});

/**
 * The seam that produces the "before" tree.
 *
 * The comparison itself is asserted against real containers in the sandbox package, but
 * that test is handed two trees built by hand. In production the base tree comes from
 * this chain — merge-base SHA, copy, checkout, clean — and a comparison run against the
 * wrong tree is worse than no comparison, because it reports a verdict with confidence.
 */
describe("the baseline tree for base-versus-head comparison", () => {
  let root: string;
  let bare: string;
  let headSha: string;
  let baseSha: string;
  let forkPoint: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "maestro-baseline-"));
    const origin = join(root, "origin");
    const git = (args: string[], cwd = origin) => exec("git", ["-C", cwd, ...args]);

    await exec("git", ["init", "--quiet", "-b", "main", origin]);
    await git(["config", "user.email", "t@example.com"]);
    await git(["config", "user.name", "Test"]);
    writeFileSync(join(origin, "test.js"), "require('./src/cart');\n");
    await git(["add", "."]);
    await git(["commit", "--quiet", "-m", "fork point"]);
    forkPoint = (await git(["rev-parse", "HEAD"])).stdout.trim();

    // The pull request ADDS a file. Only an added file distinguishes a correctly built
    // base tree from one contaminated by the head: a modified file would be overwritten
    // by the copy either way, so the mistake would be invisible.
    await git(["checkout", "--quiet", "-b", "feature"]);
    writeFileSync(join(origin, "src-cart.js"), "module.exports = {};\n");
    await git(["add", "."]);
    await git(["commit", "--quiet", "-m", "add the module the test needs"]);
    headSha = (await git(["rev-parse", "feature"])).stdout.trim();

    await git(["checkout", "--quiet", "main"]);
    writeFileSync(join(origin, "unrelated.txt"), "moved on\n");
    await git(["add", "."]);
    await git(["commit", "--quiet", "-m", "base branch moves on"]);
    baseSha = (await git(["rev-parse", "main"])).stdout.trim();

    bare = join(root, "bare.git");
    await exec("git", ["init", "--quiet", "--bare", bare]);
    await git(["push", "--quiet", bare, "--all"]);
  }, 60_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const pr = (): PullRequestContext =>
    ({
      owner: "o",
      repo: "r",
      number: 1,
      headSha,
      baseSha,
      cloneUrl: bare,
    }) as unknown as PullRequestContext;

  it("returns the fork point, not the tip of the base branch", async () => {
    // `ensureMergeBase` computed this and threw it away, returning a boolean. The base
    // branch tip carries commits this pull request did not make, so measuring a command
    // against it would measure other people's work too.
    const dir = join(root, "work-sha");
    const result = await checkoutPullRequest(pr(), dir);
    expect(result.mergeBaseSha).toBe(forkPoint);
    expect(result.mergeBaseSha).not.toBe(baseSha);
  }, 60_000);

  it("builds a base tree without the file the pull request adds", async () => {
    const dir = join(root, "work-tree");
    const checkout = await checkoutPullRequest(pr(), dir);
    // Guard against a vacuous pass: the head checkout must actually contain the new file,
    // or "the baseline lacks it" is satisfied by nothing ever having it.
    expect(existsSync(join(dir, "src-cart.js"))).toBe(true);

    const baseline = await materialiseBaseline(dir, checkout.mergeBaseSha, {
      info: () => {},
      warn: () => {},
    });
    expect(baseline).toBeTruthy();
    try {
      expect(existsSync(join(baseline as string, "test.js"))).toBe(true);
      expect(existsSync(join(baseline as string, "src-cart.js"))).toBe(false);
      expect(existsSync(join(baseline as string, "unrelated.txt"))).toBe(false);
    } finally {
      rmSync(baseline as string, { recursive: true, force: true });
    }
  }, 60_000);

  it("leaves no untracked file from the head behind in the baseline", async () => {
    // `git checkout` does not move untracked files, so without `git clean -fd` the head
    // checkout's leftovers would sit in the baseline and be measured as though they were
    // the base — the same contamination as the overlay bug, by a different route.
    const dir = join(root, "work-dirty");
    const checkout = await checkoutPullRequest(pr(), dir);
    writeFileSync(join(dir, "untracked-from-head.txt"), "should not survive\n");

    const baseline = await materialiseBaseline(dir, checkout.mergeBaseSha, {
      info: () => {},
      warn: () => {},
    });
    try {
      expect(existsSync(join(baseline as string, "untracked-from-head.txt"))).toBe(false);
    } finally {
      rmSync(baseline as string, { recursive: true, force: true });
    }
  }, 60_000);

  it("reports no baseline rather than inventing one when the fork point is unknown", async () => {
    const baseline = await materialiseBaseline(root, null, { info: () => {}, warn: () => {} });
    expect(baseline).toBeUndefined();
  });
});
