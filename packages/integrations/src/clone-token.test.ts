import { describe, expect, it, vi } from "vitest";
import { GitHubClient } from "./github.js";

/**
 * The token used to clone a pull request.
 *
 * This is pinned because leaving the argument off `octokit.auth()` broke every
 * App-authenticated review, and nothing noticed for as long as the App path existed. A
 * personal token strategy hands back what it was given whatever you pass it, so the call
 * looked correct and was exercised constantly; `@octokit/auth-app` reads `options.type`
 * and throws on the way past, so the preferred credential — the one the manifest flow
 * creates — failed before it cloned anything, with an error mentioning neither GitHub nor
 * authentication.
 *
 * The lesson these assert is narrow and keeps recurring here: a branch nothing runs is a
 * branch nobody has checked, and "it works" usually means "the path I use works".
 */

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----";

/** Replaces the auth function, capturing what it was called with. */
function withAuth(client: GitHubClient, impl: (opts?: unknown) => Promise<unknown>) {
  (client as unknown as { octokit: { auth: unknown } }).octokit = { auth: impl };
  return client;
}

describe("cloneToken", () => {
  it("asks an App for an installation token, by type", async () => {
    const seen: unknown[] = [];
    const client = withAuth(
      new GitHubClient({
        kind: "app",
        app: { appId: "1", privateKey: PEM, installationId: 99 },
      }),
      async (opts) => {
        seen.push(opts);
        return { token: "ghs_installation" };
      },
    );

    await expect(client.cloneToken()).resolves.toBe("ghs_installation");
    // The whole bug: this was `undefined`, and auth-app read `.type` off it.
    expect(seen[0]).toMatchObject({ type: "installation", installationId: 99 });
  });

  it("asks a personal token for nothing, because that strategy takes no options", async () => {
    const seen: unknown[] = [];
    const client = withAuth(new GitHubClient({ kind: "token", token: "t" }), async (opts) => {
      seen.push(opts);
      return { token: "ghp_personal" };
    });

    await expect(client.cloneToken()).resolves.toBe("ghp_personal");
    expect(seen[0]).toBeUndefined();
  });

  it("returns nothing for an App with no installation rather than throwing from a library", async () => {
    // An App exists before anybody installs it — the state the manifest flow leaves you
    // in by design. It cannot mint an installation token, and saying so by returning
    // nothing lets the clone fail on a missing credential, which is the actual problem.
    const auth = vi.fn();
    const client = withAuth(
      new GitHubClient({ kind: "app", app: { appId: "1", privateKey: PEM } }),
      auth,
    );
    await expect(client.cloneToken()).resolves.toBeUndefined();
    expect(auth).not.toHaveBeenCalled();
  });
});
