import { describe, expect, it, vi } from "vitest";
import { GitHubClient } from "./github.js";

/**
 * A failed call must not look like an absent file.
 *
 * `getBaseBranchConfig` returned null for every error, so a request that failed for any
 * reason — wrong arguments, a revoked token, a network fault — reported "this repository
 * has no `.maestro.yaml`". The repository's own configuration then silently stops
 * applying and nothing anywhere says so. Found by calling it with the wrong arguments
 * during a live check against the real API: the request went to `/repos///contents/...`,
 * GitHub answered 404, and the function reported the file as absent.
 */
const withRest = (rest: unknown): GitHubClient => {
  const client = new GitHubClient({ kind: "token", token: "t" });
  (client as unknown as { octokit: { rest: unknown } }).octokit = { rest };
  return client;
};

const pr = {
  owner: "acme",
  repo: "web",
  number: 1,
  baseRef: "main",
} as unknown as Parameters<GitHubClient["getBaseBranchConfig"]>[0];

describe("reading the base branch config", () => {
  it("stays quiet about a repository that simply has no config file", async () => {
    const warn = vi.spyOn(console, "warn");
    const client = withRest({
      repos: {
        getContent: async () => {
          throw Object.assign(new Error("Not Found"), { status: 404 });
        },
      },
    });
    await expect(client.getBaseBranchConfig(pr)).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("still continues without it when the call fails for another reason", async () => {
    // Continuing is right — a review is more useful than no review — but it must not be
    // silent, which is what made a broken call indistinguishable from an absent file.
    const client = withRest({
      repos: {
        getContent: async () => {
          throw Object.assign(new Error("Bad credentials"), { status: 401 });
        },
      },
    });
    await expect(client.getBaseBranchConfig(pr)).resolves.toBeNull();
  });

  it("decodes the file when there is one", async () => {
    const client = withRest({
      repos: {
        getContent: async () => ({
          data: { content: Buffer.from("trust: untrusted\n").toString("base64") },
        }),
      },
    });
    await expect(client.getBaseBranchConfig(pr)).resolves.toBe("trust: untrusted\n");
  });

  it("returns null for a directory, which has no content to decode", async () => {
    const client = withRest({ repos: { getContent: async () => ({ data: [{ name: "a" }] }) } });
    await expect(client.getBaseBranchConfig(pr)).resolves.toBeNull();
  });
});
