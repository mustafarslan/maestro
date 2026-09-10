import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHubClient } from "./github.js";
import { githubAppPath, saveGitHubApp } from "./github-app.js";

/**
 * Finding an App's installations.
 *
 * This exists so nobody has to copy an installation id out of a browser URL — the one
 * step of the setup flow that asked for a number the operator had no way to know. What
 * makes it non-obvious is the credential: `GET /app/installations` needs an app JWT, and
 * a client built with an installation id issues installation tokens instead, which that
 * endpoint refuses with a 403 naming no cause.
 */

let home: string;
const saved = { ...process.env };

/** A syntactically valid key; nothing here reaches GitHub, so it is never used to sign. */
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "maestro-inst-"));
  process.env.MAESTRO_HOME = home;
  for (const v of [
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_INSTALLATION_ID",
  ]) {
    delete process.env[v];
  }
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  process.env = { ...saved };
});

function storeApp(installationId?: number) {
  saveGitHubApp({
    appId: "12345",
    slug: "maestro-test",
    privateKey: PEM,
    htmlUrl: "https://github.com/apps/maestro-test",
    installationId,
    createdAt: new Date().toISOString(),
  });
}

/** Replaces the transport, the way `github-errors.test.ts` does. */
function withInstallations(client: GitHubClient, data: unknown[]): GitHubClient {
  (client as unknown as { octokit: { rest: unknown } }).octokit = {
    rest: { apps: { listInstallations: async () => ({ data }) } },
  };
  return client;
}

describe("GitHubClient.appOnly", () => {
  it("ignores GITHUB_TOKEN, which cannot list installations at all", () => {
    // The failure this prevents: `fromEnv` prefers a personal token, correctly for
    // everything else, and a machine that had one lying around from before the App
    // existed would get a client that can never answer this question.
    storeApp();
    process.env.GITHUB_TOKEN = "ghp_something";
    const client = GitHubClient.appOnly();
    expect(client?.authKind).toBe("app");
  });

  it("drops a stored installation id, because that changes which token is issued", async () => {
    // With one set, the auth strategy issues an installation token and the endpoint
    // answers 403 with no explanation. Asserted through the guard rather than the API:
    // a client built the wrong way refuses before it can produce that 403.
    storeApp(999);
    const client = GitHubClient.appOnly();
    const listing = withInstallations(client as GitHubClient, []);
    await expect(listing.listInstallations()).resolves.toEqual([]);
  });

  it("is nothing without credentials", () => {
    expect(GitHubClient.appOnly()).toBeNull();
  });
});

describe("listing installations", () => {
  const client = () => withInstallations(GitHubClient.appOnly() as GitHubClient, []);

  it("refuses a personal token with a sentence rather than a 403", async () => {
    const token = new GitHubClient({ kind: "token", token: "t" });
    await expect(token.listInstallations()).rejects.toThrow(/personal access token/i);
  });

  it("refuses a client that is authenticated as an installation", async () => {
    // Not reachable through `appOnly`, and reachable through the normal constructor —
    // which is how somebody would hit the unexplained 403.
    const asInstallation = new GitHubClient({
      kind: "app",
      app: { appId: "1", privateKey: PEM, installationId: 42 },
    });
    await expect(asInstallation.listInstallations()).rejects.toThrow(/cannot list installations/i);
  });

  it("reports the account and what it can reach, not just an id", async () => {
    storeApp();
    const c = withInstallations(GitHubClient.appOnly() as GitHubClient, [
      { id: 7, account: { login: "acme" }, repository_selection: "selected" },
      { id: 9, account: { login: "mustafarslan" }, repository_selection: "all" },
    ]);
    await expect(c.listInstallations()).resolves.toEqual([
      { id: 7, account: "acme", repositorySelection: "selected" },
      { id: 9, account: "mustafarslan", repositorySelection: "all" },
    ]);
  });

  it("survives an installation whose account is null", async () => {
    // Octokit types it nullable. Crashing the listing would hide every other
    // installation because of one that cannot be named.
    storeApp();
    const c = withInstallations(GitHubClient.appOnly() as GitHubClient, [
      { id: 3, account: null, repository_selection: "all" },
    ]);
    await expect(c.listInstallations()).resolves.toEqual([
      { id: 3, account: "(unknown account)", repositorySelection: "all" },
    ]);
  });

  it("returns nothing when the app is installed nowhere", async () => {
    storeApp();
    await expect(client().listInstallations()).resolves.toEqual([]);
    expect(githubAppPath()).toContain(home);
  });
});
