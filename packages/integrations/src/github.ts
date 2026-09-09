import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "@maestro/core";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

const exec = promisify(execFile);

export interface GitHubAppCredentials {
  appId: string;
  privateKey: string;
  installationId?: number;
}

export type GitHubAuth =
  | { kind: "token"; token: string }
  | { kind: "app"; app: GitHubAppCredentials };

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

export interface PullRequestContext extends PullRequestRef {
  title: string;
  body: string;
  author: string;
  headSha: string;
  baseSha: string;
  baseRef: string;
  headRef: string;
  /** Fork PRs carry untrusted code and are downgraded to a stricter environment. */
  isFork: boolean;
  draft: boolean;
  changedFiles: string[];
  changedLines: number;
  cloneUrl: string;
  htmlUrl: string;
}

export interface InlineComment {
  path: string;
  line: number;
  body: string;
}

/**
 * The only component that talks to GitHub.
 *
 * Agents never hold a token: they run offline in a container and return structured
 * findings, and this class is the sole writer. That separation is what makes it safe to
 * feed attacker-controlled PR content to a model at all.
 */
export class GitHubClient {
  private readonly octokit: Octokit;
  /** Which credential this client holds. The two have different permissions. */
  readonly authKind: GitHubAuth["kind"];
  private readonly installationId?: number;

  constructor(auth: GitHubAuth, baseUrl?: string) {
    this.authKind = auth.kind;
    this.installationId = auth.kind === "app" ? auth.app.installationId : undefined;
    this.octokit =
      auth.kind === "token"
        ? new Octokit({ auth: auth.token, baseUrl })
        : new Octokit({
            baseUrl,
            authStrategy: createAppAuth,
            auth: {
              appId: auth.app.appId,
              privateKey: auth.app.privateKey,
              installationId: auth.app.installationId,
            },
          });
  }

  static fromEnv(): GitHubClient | null {
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (token) return new GitHubClient({ kind: "token", token });
    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
    if (appId && privateKey) {
      return new GitHubClient({
        kind: "app",
        app: {
          appId,
          privateKey: privateKey.replaceAll("\\n", "\n"),
          installationId: process.env.GITHUB_APP_INSTALLATION_ID
            ? Number(process.env.GITHUB_APP_INSTALLATION_ID)
            : undefined,
        },
      });
    }
    return null;
  }

  /**
   * Who this credential is, for `maestro doctor`.
   *
   * Branches on the credential because the two cannot call the same endpoint. `GET /user`
   * is what identifies a personal token, and an installation token is refused it with
   * 403 "Resource not accessible by integration" — so asking every credential for a user
   * login would report the *preferred* configuration, a GitHub App, as broken. An
   * installation is identified by what it can reach instead.
   */
  async identity(): Promise<string> {
    if (this.authKind === "token") {
      const { data } = await this.octokit.rest.users.getAuthenticated();
      return `user ${data.login}`;
    }
    if (this.installationId) {
      const { data } = await this.octokit.rest.apps.listReposAccessibleToInstallation({
        per_page: 1,
      });
      return `app installation ${this.installationId}, ${data.total_count} repositor${
        data.total_count === 1 ? "y" : "ies"
      }`;
    }
    // No installation id: the strategy issues an app JWT rather than an installation
    // token, and that one may ask about the app itself.
    const { data } = await this.octokit.rest.apps.getAuthenticated();
    return `app ${data?.slug ?? data?.name ?? "(unnamed)"} (no installation id set)`;
  }

  async getPullRequest(ref: PullRequestRef): Promise<PullRequestContext> {
    const { data: pr } = await this.octokit.rest.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
    });

    const files = await this.octokit.paginate(this.octokit.rest.pulls.listFiles, {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
      per_page: 100,
    });

    return {
      ...ref,
      title: pr.title,
      body: pr.body ?? "",
      author: pr.user?.login ?? "unknown",
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      baseRef: pr.base.ref,
      headRef: pr.head.ref,
      // A fork PR is code from outside the org: treat it as untrusted.
      isFork: pr.head.repo?.full_name !== pr.base.repo.full_name,
      draft: pr.draft ?? false,
      changedFiles: files.map((f) => f.filename),
      changedLines: files.reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0),
      cloneUrl: pr.base.repo.clone_url,
      htmlUrl: pr.html_url,
    };
  }

  async listOpenPullRequests(owner: string, repo: string): Promise<PullRequestRef[]> {
    const prs = await this.octokit.paginate(this.octokit.rest.pulls.list, {
      owner,
      repo,
      state: "open",
      per_page: 100,
    });
    return prs.map((pr) => ({ owner, repo, number: pr.number }));
  }

  /**
   * Reads a repo's Maestro config from the BASE branch only.
   *
   * Never from the PR head: otherwise a fork PR simply edits this file to widen the
   * egress allowlist or add `curl … | sh` as an allowlisted "test command".
   */
  async getBaseBranchConfig(
    pr: PullRequestContext,
    path = ".maestro.yaml",
  ): Promise<string | null> {
    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner: pr.owner,
        repo: pr.repo,
        path,
        ref: pr.baseRef,
      });
      if (!("content" in data)) return null;
      return Buffer.from(data.content, "base64").toString("utf8");
    } catch {
      return null;
    }
  }

  /**
   * Files changed between two commits.
   *
   * Distinct from a pull request's file list, which is cumulative against the base. The
   * line-change quality signal needs the delta since the last review: a finding points at
   * a file in the PR's diff by construction, so asking "is this file in the PR's diff"
   * answers yes for every finding and marks them all accepted.
   */
  async filesChangedBetween(
    pr: PullRequestRef,
    base: string,
    head: string,
  ): Promise<string[] | null> {
    try {
      const { data } = await this.octokit.rest.repos.compareCommits({
        owner: pr.owner,
        repo: pr.repo,
        base,
        head,
      });

      // GitHub caps the files a single compare returns. A truncated list read as
      // complete turns "we did not see this file" into "this file did not change" —
      // exactly the shape of the defect this method was added to fix, and a partial
      // "no" is still a verdict. Unknown is the honest answer.
      const files = data.files ?? [];
      if (data.total_commits > 0 && files.length >= 300) {
        logger.warn(
          { pr: pr.number, files: files.length },
          "compare response may be truncated; treating the delta as unknown",
        );
        return null;
      }
      return files.map((f) => f.filename);
    } catch {
      // Unknown rather than empty: an empty list would read as "nothing was addressed"
      // and silently settle nothing, which is the safer failure but a different claim.
      return null;
    }
  }

  /** Short-lived token for cloning. Never enters a container. */
  async cloneToken(): Promise<string | undefined> {
    const auth = (await this.octokit.auth()) as { token?: string };
    return auth?.token;
  }

  /**
   * Posts one consolidated review. Inline comments are attempted first; if GitHub
   * rejects an anchor (the line is not in the diff), the whole thing degrades to a
   * single issue comment rather than losing the review.
   */
  async postReview(
    pr: PullRequestContext,
    body: string,
    inline: InlineComment[] = [],
  ): Promise<{ id: number; mode: "review" | "comment" }> {
    if (inline.length) {
      try {
        const { data } = await this.octokit.rest.pulls.createReview({
          owner: pr.owner,
          repo: pr.repo,
          pull_number: pr.number,
          commit_id: pr.headSha,
          event: "COMMENT",
          body,
          comments: inline.map((c) => ({
            path: c.path,
            line: c.line,
            body: c.body,
            side: "RIGHT",
          })),
        });
        return { id: data.id, mode: "review" };
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "inline review rejected; falling back to a single comment",
        );
      }
    }

    const { data } = await this.octokit.rest.issues.createComment({
      owner: pr.owner,
      repo: pr.repo,
      issue_number: pr.number,
      body,
    });
    return { id: data.id, mode: "comment" };
  }

  /** Finds a previous Maestro comment so a re-review updates rather than piles on. */
  async findPreviousComment(pr: PullRequestContext, marker: string): Promise<number | null> {
    const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      owner: pr.owner,
      repo: pr.repo,
      issue_number: pr.number,
      per_page: 100,
    });
    const mine = comments.filter((c) => (c.body ?? "").includes(marker));
    return mine.length ? (mine.at(-1)?.id ?? null) : null;
  }

  async updateComment(pr: PullRequestRef, commentId: number, body: string): Promise<void> {
    await this.octokit.rest.issues.updateComment({
      owner: pr.owner,
      repo: pr.repo,
      comment_id: commentId,
      body,
    });
  }
}

/**
 * Clones a PR head into a working directory.
 *
 * Done host-side so the credential never enters a container, and with a shallow fetch of
 * just the two commits under review — a full history clone of a large repo is minutes of
 * wall-clock for no benefit.
 */
export async function checkoutPullRequest(
  pr: PullRequestContext,
  dir: string,
  token?: string,
  /** Extra commit to fetch, so an incremental review can diff against the last round. */
  alsoFetch?: string,
): Promise<void> {
  const url = token
    ? pr.cloneUrl.replace("https://", `https://x-access-token:${token}@`)
    : pr.cloneUrl;

  const run = (args: string[]) => exec("git", args, { maxBuffer: 64 * 1024 * 1024 });

  await run(["init", "--quiet", dir]);
  await run(["-C", dir, "remote", "add", "origin", url]);
  // Both SHAs are needed: head to review, base to diff against.
  const wanted = [
    pr.headSha,
    pr.baseSha,
    ...(alsoFetch && alsoFetch !== pr.baseSha ? [alsoFetch] : []),
  ];
  try {
    await run(["-C", dir, "fetch", "--quiet", "--depth", "50", "origin", ...wanted]);
  } catch {
    // A previous head may have been force-pushed away; the review still has to happen,
    // so fall back to the base and let the caller's diff degrade to a full review.
    await run(["-C", dir, "fetch", "--quiet", "--depth", "50", "origin", pr.headSha, pr.baseSha]);
  }
  await run(["-C", dir, "checkout", "--quiet", pr.headSha]);
  // Strip the credential so it cannot leak via .git/config into the container.
  await run(["-C", dir, "remote", "set-url", "origin", pr.cloneUrl]);
}
