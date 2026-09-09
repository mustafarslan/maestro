import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger, maestroHome } from "@maestro/core";

/**
 * GitHub App credentials, on disk.
 *
 * The manifest flow hands back a private key once and never again, so it has to be kept
 * somewhere. Not an environment variable: a PEM is multi-line, ends up in shell history
 * and process listings, and asking somebody to paste one is most of the friction the
 * manifest flow exists to remove. Not the database either — key material does not belong
 * in a file people copy between machines to move their review history.
 *
 * 0600 in MAESTRO_HOME, which is already 0700.
 */
export interface StoredGitHubApp {
  appId: string;
  slug?: string;
  privateKey: string;
  webhookSecret?: string;
  installationId?: number;
  htmlUrl?: string;
  createdAt: string;
}

export function githubAppPath(): string {
  return join(maestroHome(), "github-app.json");
}

/** Returns undefined for anything unreadable: a broken file is "not configured". */
export function storedGitHubApp(): StoredGitHubApp | undefined {
  const path = githubAppPath();
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as StoredGitHubApp;
    return parsed.appId && parsed.privateKey ? parsed : undefined;
  } catch {
    // Deliberately quiet at read time — every command that resolves a credential calls
    // this, and a warning per command about a file the operator has to fix anyway is
    // noise. `maestro doctor` is where a broken credential is reported.
    return undefined;
  }
}

export function saveGitHubApp(app: StoredGitHubApp): string {
  const path = githubAppPath();
  writeFileSync(path, `${JSON.stringify(app, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync's mode is ignored when the file already exists.
  chmodSync(path, 0o600);
  logger.info({ appId: app.appId, path }, "stored GitHub App credentials");
  return path;
}

/** Records which installation to act as, once somebody has installed the app. */
export function setInstallationId(installationId: number): boolean {
  const app = storedGitHubApp();
  if (!app) return false;
  saveGitHubApp({ ...app, installationId });
  return true;
}

/**
 * The manifest GitHub renders as "create this app for me".
 *
 * Permissions are the least that lets Maestro do its job, and are worth reading as the
 * security statement they are: it reads pull requests and their contents, and writes
 * only review comments. No write access to code, no administration, no secrets.
 */
export function appManifest(opts: {
  name: string;
  redirectUrl: string;
  webhookUrl?: string;
  public?: boolean;
}): Record<string, unknown> {
  return {
    name: opts.name,
    url: "https://github.com/mustafarslan/maestro",
    hook_attributes: opts.webhookUrl
      ? { url: opts.webhookUrl, active: true }
      : // An app with no reachable webhook is still useful: `maestro serve --poll`
        // works behind NAT, and the URL can be filled in later.
        { url: "https://example.invalid/unused", active: false },
    redirect_url: opts.redirectUrl,
    public: opts.public ?? false,
    default_permissions: {
      contents: "read",
      metadata: "read",
      pull_requests: "write",
      issues: "write",
      checks: "read",
    },
    default_events: ["pull_request", "issue_comment", "pull_request_review_comment"],
  };
}

/**
 * Exchanges the temporary code GitHub redirects with for real credentials.
 *
 * The code is valid for one hour and single-use, which is why this is a separate,
 * testable function rather than something buried in a request handler.
 */
export async function exchangeManifestCode(
  code: string,
  opts: { apiBase?: string; fetchImpl?: typeof fetch } = {},
): Promise<StoredGitHubApp> {
  const base = opts.apiBase ?? "https://api.github.com";
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${base}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(
      `GitHub refused the manifest exchange (${res.status}). The code is single-use and ` +
        "expires after an hour; run the command again to start a fresh one.",
    );
  }
  const body = (await res.json()) as {
    id?: number;
    slug?: string;
    pem?: string;
    webhook_secret?: string;
    html_url?: string;
  };
  if (!body.id || !body.pem) {
    throw new Error("GitHub's response carried no app id or private key");
  }
  return {
    appId: String(body.id),
    slug: body.slug,
    privateKey: body.pem,
    webhookSecret: body.webhook_secret,
    htmlUrl: body.html_url,
    createdAt: new Date().toISOString(),
  };
}
