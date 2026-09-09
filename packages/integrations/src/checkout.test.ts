import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkoutPullRequest, type PullRequestContext } from "./github.js";

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
