import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubClient, saveGitHubApp, storedGitHubApp } from "@maestro/integrations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubApp } from "./commands/github-app.js";

/**
 * `maestro github-app installed`, with and without an id.
 *
 * The id was a required argument, obtainable only from the URL bar after installing the
 * App. These pin the behaviour that replaced it, including the two cases that matter more
 * than the happy one: an id that belongs to no installation of this App must not be
 * recorded, and GitHub being unreachable must not stop somebody who already knows the
 * number.
 */

let home: string;
const saved = { ...process.env };
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "maestro-ghi-"));
  process.env.MAESTRO_HOME = home;
  for (const v of ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"]) {
    delete process.env[v];
  }
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  process.env = { ...saved };
});

function storeApp() {
  saveGitHubApp({
    appId: "12345",
    slug: "maestro-test",
    privateKey: PEM,
    htmlUrl: "https://github.com/apps/maestro-test",
    createdAt: new Date().toISOString(),
  });
}

/** Makes `GitHubClient.appOnly()` answer with a fixed set, or fail. */
function stubListing(result: unknown[] | Error) {
  vi.spyOn(GitHubClient, "appOnly").mockImplementation(
    () =>
      ({
        authKind: "app",
        listInstallations: async () => {
          if (result instanceof Error) throw result;
          return result;
        },
      }) as unknown as GitHubClient,
  );
}

describe("maestro github-app installed", () => {
  it("records the only installation without being told which", async () => {
    storeApp();
    stubListing([{ id: 4242, account: "mustafarslan", repositorySelection: "all" }]);
    expect(await githubApp(["installed"])).toBe(0);
    expect(storedGitHubApp()?.installationId).toBe(4242);
  });

  it("refuses to guess when there is more than one, and says how to choose", async () => {
    // A personal App and an organisation App is the normal shape for somebody reviewing
    // their own projects and their employer's, so this is a state to handle, not an error.
    storeApp();
    stubListing([
      { id: 1, account: "mustafarslan", repositorySelection: "all" },
      { id: 2, account: "acme", repositorySelection: "selected" },
    ]);
    expect(await githubApp(["installed"])).toBe(1);
    expect(storedGitHubApp()?.installationId).toBeUndefined();
  });

  it("does not record an id that belongs to no installation of this app", async () => {
    // The typo case. Recording it produces a daemon that authenticates as nothing and
    // fails on its first review, a long way from the mistake.
    storeApp();
    stubListing([{ id: 4242, account: "mustafarslan", repositorySelection: "all" }]);
    expect(await githubApp(["installed", "4243"])).toBe(1);
    expect(storedGitHubApp()?.installationId).toBeUndefined();
  });

  it("records an id that does match", async () => {
    storeApp();
    stubListing([{ id: 4242, account: "mustafarslan", repositorySelection: "all" }]);
    expect(await githubApp(["installed", "4242"])).toBe(0);
    expect(storedGitHubApp()?.installationId).toBe(4242);
  });

  it("still records a known id when GitHub cannot be reached", async () => {
    // The check is a convenience. Making it a hard dependency would mean somebody who
    // already has the number cannot configure Maestro because GitHub is down.
    storeApp();
    stubListing(new Error("getaddrinfo ENOTFOUND api.github.com"));
    expect(await githubApp(["installed", "77"])).toBe(0);
    expect(storedGitHubApp()?.installationId).toBe(77);
  });

  it("fails rather than guessing when it cannot list and was given nothing", async () => {
    storeApp();
    stubListing(new Error("getaddrinfo ENOTFOUND api.github.com"));
    expect(await githubApp(["installed"])).toBe(1);
    expect(storedGitHubApp()?.installationId).toBeUndefined();
  });

  it("points at the install page when the app is installed nowhere", async () => {
    storeApp();
    stubListing([]);
    expect(await githubApp(["installed"])).toBe(1);
    expect(storedGitHubApp()?.installationId).toBeUndefined();
  });

  it("says to create an app first when there is none", async () => {
    expect(await githubApp(["installed"])).toBe(1);
  });

  it("still rejects an id that is not a positive integer", async () => {
    storeApp();
    stubListing([]);
    expect(await githubApp(["installed", "-3"])).toBe(1);
    expect(await githubApp(["installed", "banana"])).toBe(1);
  });
});
