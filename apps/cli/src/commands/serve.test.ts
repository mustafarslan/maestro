import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveGitHubApp } from "@maestro/integrations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWebhookSecret } from "./serve.js";

let home: string;
const saved = { ...process.env };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "maestro-serve-"));
  process.env.MAESTRO_HOME = home;
  delete process.env.GITHUB_WEBHOOK_SECRET;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  process.env = { ...saved };
});

const app = (webhookSecret?: string) =>
  saveGitHubApp({
    appId: "42",
    privateKey: "k",
    webhookSecret,
    createdAt: new Date().toISOString(),
  });

describe("where the webhook secret comes from", () => {
  it("uses the one GitHub generated for the App", () => {
    // Otherwise `maestro github-app create --webhook-url ...` produces an App whose
    // deliveries are signed with a secret Maestro has on disk and will not use, and
    // `serve` refuses to start pointing at an environment variable nobody was shown.
    app("from-github");
    expect(resolveWebhookSecret([])).toBe("from-github");
  });

  it("lets the environment override it", () => {
    app("from-github");
    process.env.GITHUB_WEBHOOK_SECRET = "from-env";
    expect(resolveWebhookSecret([])).toBe("from-env");
  });

  it("lets the flag override both", () => {
    app("from-github");
    process.env.GITHUB_WEBHOOK_SECRET = "from-env";
    expect(resolveWebhookSecret(["--webhook-secret=from-flag"])).toBe("from-flag");
  });

  it("is undefined when there is nothing to find, so the listener still refuses to start", () => {
    expect(resolveWebhookSecret([])).toBeUndefined();
    app(undefined);
    expect(resolveWebhookSecret([])).toBeUndefined();
  });
});
