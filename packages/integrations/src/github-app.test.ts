import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHubClient } from "./github.js";
import {
  appManifest,
  exchangeManifestCode,
  githubAppPath,
  saveGitHubApp,
  setInstallationId,
  storedGitHubApp,
} from "./github-app.js";

let home: string;
const saved = { ...process.env };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "maestro-app-"));
  process.env.MAESTRO_HOME = home;
  for (const v of ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"]) {
    delete process.env[v];
  }
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  process.env = { ...saved };
});

describe("the app manifest", () => {
  it("asks for read on code and write only on pull requests", () => {
    // The manifest is the security statement an operator confirms in one click, so what
    // it requests matters more than most configuration in this repository.
    const m = appManifest({ name: "maestro-test", redirectUrl: "http://127.0.0.1:1/callback" });
    const perms = m.default_permissions as Record<string, string>;
    expect(perms.contents).toBe("read");
    expect(perms.pull_requests).toBe("write");
    expect(perms).not.toHaveProperty("administration");
    expect(m.public).toBe(false);
  });

  it("disables the webhook rather than pointing it somewhere wrong", () => {
    // A poll-mode install has no public URL. An app carrying a plausible-looking but dead
    // webhook would show deliveries failing for ever in GitHub's UI.
    const m = appManifest({ name: "n", redirectUrl: "http://127.0.0.1:1/callback" });
    expect((m.hook_attributes as { active: boolean }).active).toBe(false);

    const withHook = appManifest({
      name: "n",
      redirectUrl: "http://127.0.0.1:1/callback",
      webhookUrl: "https://example.com/hook",
    });
    expect(withHook.hook_attributes).toMatchObject({
      url: "https://example.com/hook",
      active: true,
    });
  });
});

describe("exchanging the manifest code", () => {
  const ok = async (): Promise<Response> =>
    new Response(
      JSON.stringify({ id: 42, slug: "maestro-x", pem: "-----BEGIN----", webhook_secret: "s" }),
      { status: 200 },
    );

  it("returns credentials from GitHub's response", async () => {
    const app = await exchangeManifestCode("code-1", {
      apiBase: "https://api.test",
      fetchImpl: ok as unknown as typeof fetch,
    });
    expect(app).toMatchObject({ appId: "42", slug: "maestro-x", webhookSecret: "s" });
  });

  it("says the code is single-use rather than reporting a bare status", async () => {
    // The one failure an operator actually hits: the flow was retried, or an hour passed.
    await expect(
      exchangeManifestCode("stale", {
        fetchImpl: (async () => new Response("", { status: 404 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/single-use|expires/);
  });

  it("refuses a response with no private key instead of storing a useless app", async () => {
    await expect(
      exchangeManifestCode("c", {
        fetchImpl: (async () =>
          new Response(JSON.stringify({ id: 7 }), { status: 200 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/private key/);
  });
});

describe("stored credentials", () => {
  const app = {
    appId: "42",
    privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    createdAt: new Date().toISOString(),
  };

  it("writes the private key 0600", () => {
    const path = saveGitHubApp(app);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain("BEGIN PRIVATE KEY");
  });

  it("is what GitHubClient falls back to when no environment variable is set", () => {
    // Without this the manifest flow would store a key nothing reads, and the operator
    // would still have to paste a PEM into an environment variable — most of the friction
    // the flow exists to remove.
    expect(GitHubClient.fromEnv()).toBeNull();
    saveGitHubApp(app);
    const client = GitHubClient.fromEnv();
    expect(client?.authKind).toBe("app");
  });

  it("lets a token still win, since that is the explicit choice", () => {
    saveGitHubApp(app);
    process.env.GITHUB_TOKEN = "ghp_x";
    expect(GitHubClient.fromEnv()?.authKind).toBe("token");
  });

  it("records the installation id after the app is installed", () => {
    saveGitHubApp(app);
    expect(setInstallationId(99)).toBe(true);
    expect(storedGitHubApp()?.installationId).toBe(99);
    // And the private key survived the update.
    expect(storedGitHubApp()?.privateKey).toContain("BEGIN PRIVATE KEY");
  });

  it("refuses to record an installation when no app is stored", () => {
    expect(setInstallationId(99)).toBe(false);
  });

  it("treats a corrupt file as 'not configured' rather than crashing every command", () => {
    writeFileSync(githubAppPath(), "{not json");
    expect(storedGitHubApp()).toBeUndefined();
    expect(GitHubClient.fromEnv()).toBeNull();
  });
});

describe("identifying an App credential", () => {
  // Neither App branch of `identity()` runs anywhere else: one needs an installation and
  // the other an app JWT, and no App exists to point them at. Mocking octokit's rest
  // surface exercises the branching — which endpoint each state asks for — which is the
  // part that was wrong before (`GET /user` for everything, refused to an installation
  // token with a 403, reporting the *preferred* configuration as broken).
  const withRest = (client: GitHubClient, rest: unknown): GitHubClient => {
    (client as unknown as { octokit: { rest: unknown } }).octokit = { rest };
    return client;
  };

  it("asks what an installation can reach, not who the user is", async () => {
    saveGitHubApp({
      appId: "42",
      privateKey: "k",
      installationId: 7,
      createdAt: new Date().toISOString(),
    });
    const client = GitHubClient.fromEnv() as GitHubClient;
    let asked = "";
    withRest(client, {
      users: {
        getAuthenticated: async () => {
          asked = "users";
          return { data: { login: "nope" } };
        },
      },
      apps: {
        listReposAccessibleToInstallation: async () => {
          asked = "installation";
          return { data: { total_count: 3 } };
        },
      },
    });

    await expect(client.identity()).resolves.toBe("app installation 7, 3 repositories");
    expect(asked).toBe("installation");
  });

  it("asks about the app itself when no installation is recorded", async () => {
    saveGitHubApp({ appId: "42", privateKey: "k", createdAt: new Date().toISOString() });
    const client = GitHubClient.fromEnv() as GitHubClient;
    withRest(client, {
      apps: { getAuthenticated: async () => ({ data: { slug: "maestro-x" } }) },
    });
    await expect(client.identity()).resolves.toMatch(/app maestro-x .*no installation id/);
  });

  it("says 'repository' rather than 'repositorys' for a single one", async () => {
    saveGitHubApp({
      appId: "42",
      privateKey: "k",
      installationId: 7,
      createdAt: new Date().toISOString(),
    });
    const client = GitHubClient.fromEnv() as GitHubClient;
    withRest(client, {
      apps: { listReposAccessibleToInstallation: async () => ({ data: { total_count: 1 } }) },
    });
    await expect(client.identity()).resolves.toContain("1 repository");
  });
});
