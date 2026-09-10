import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "@maestro/core";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { storedGitHubApp } from "./github-app.js";
import { commentableAnchors } from "./patch.js";

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
  /**
   * Which lines of which files can carry an inline comment, from the diff GitHub already
   * sent with the file list. Built here because `listFiles` is the only place the patch
   * is available and it was being thrown away; asking for it again at post time would
   * double the request for data already in hand.
   */
  commentable: Map<string, Set<number>>;
  cloneUrl: string;
  htmlUrl: string;
}

export interface InlineComment {
  path: string;
  line: number;
  body: string;
}

/**
 * Which of GitHub's two comment resources a finding's feedback lives on.
 *
 * They have different reaction endpoints and independent id sequences, so the kind must
 * be stored beside the id rather than derived from it.
 */
export type PostedCommentKind = "summary" | "inline";

/** An anchored comment that landed, and where. */
export interface PostedInlineComment {
  id: number;
  path: string;
  line: number;
}

/**
 * The only component that talks to GitHub.
 *
 * Agents never hold a token: they run offline in a container and return structured
 * findings, and this class is the sole writer. That separation is what makes it safe to
 * feed attacker-controlled PR content to a model at all.
 */
/** One place this App is installed, as `maestro github-app installed` reports it. */
export interface AppInstallation {
  id: number;
  account: string;
  repositorySelection: "all" | "selected";
}

export class GitHubClient {
  private readonly octokit: Octokit;
  /** Which credential this client holds. The two have different permissions. */
  readonly authKind: GitHubAuth["kind"];
  private readonly installationId?: number;
  private readonly appId?: string;

  constructor(auth: GitHubAuth, baseUrl?: string) {
    this.authKind = auth.kind;
    this.installationId = auth.kind === "app" ? auth.app.installationId : undefined;
    this.appId = auth.kind === "app" ? auth.app.appId : undefined;
    this.octokit =
      auth.kind === "token"
        ? new Octokit({ auth: auth.token, baseUrl })
        : new Octokit({
            baseUrl,
            authStrategy: createAppAuth,
            auth: {
              appId: auth.app.appId,
              privateKey: auth.app.privateKey,
              // Omitted, never passed as undefined: `@octokit/auth-app` throws
              // "installationId is set to a falsy value" on the key being present at all.
              // `fromEnv` has always treated it as optional, so an App configured without
              // GITHUB_APP_INSTALLATION_ID threw at construction — a branch nothing
              // exercised until the manifest flow made it the normal first state, since
              // an app has no installation until somebody installs it.
              ...(auth.app.installationId ? { installationId: auth.app.installationId } : {}),
            },
          });
  }

  static fromEnv(): GitHubClient | null {
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (token) return new GitHubClient({ kind: "token", token });

    // Environment first, then the file `maestro init --github-app` writes. Without the
    // second, the manifest flow would store a private key nowhere anything reads it and
    // the operator would still have to paste a PEM into an environment variable, which
    // is most of what the flow exists to avoid.
    const stored = storedGitHubApp();
    const appId = process.env.GITHUB_APP_ID ?? stored?.appId;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY ?? stored?.privateKey;
    if (appId && privateKey) {
      const installationId =
        process.env.GITHUB_APP_INSTALLATION_ID ?? stored?.installationId?.toString();
      return new GitHubClient({
        kind: "app",
        app: {
          appId,
          // A PEM pasted into an environment variable arrives with literal backslash-n.
          privateKey: privateKey.replaceAll("\\n", "\n"),
          installationId: installationId ? Number(installationId) : undefined,
        },
      });
    }
    return null;
  }

  /**
   * A client authenticated as the App itself, never as one of its installations.
   *
   * Two deliberate differences from `fromEnv`, and both matter.
   *
   * It does not consult `GITHUB_TOKEN`. A personal token cannot list an App's
   * installations at all, so preferring one — which `fromEnv` does, correctly, for
   * everything else — would make this fail on exactly the machines most likely to have a
   * token lying around from before the App existed.
   *
   * And it drops `installationId` rather than passing it through. With one set, the auth
   * strategy issues an *installation* token, and `GET /app/installations` refuses those
   * with a 403 that names no cause. Destructured field by field rather than spread, so a
   * field added to the stored file later cannot quietly reintroduce that.
   */
  static appOnly(): GitHubClient | null {
    const stored = storedGitHubApp();
    const appId = process.env.GITHUB_APP_ID ?? stored?.appId;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY ?? stored?.privateKey;
    if (!appId || !privateKey) return null;
    return new GitHubClient({
      kind: "app",
      app: { appId, privateKey: privateKey.replaceAll("\\n", "\n") },
    });
  }

  /**
   * Where this App is installed.
   *
   * Exists so nobody has to copy an installation id out of a browser URL. That was the
   * one step of the setup flow that asked the operator for a number they had no way to
   * know, in the middle of a flow whose entire purpose is not making people fill in
   * fields by hand.
   */
  async listInstallations(): Promise<AppInstallation[]> {
    if (this.authKind !== "app") {
      throw new Error(
        "a personal access token cannot list App installations - this needs GitHub App " +
          "credentials, created with 'maestro github-app create'",
      );
    }
    if (this.installationId) {
      // Would 403 with no explanation. Caught here so the message names the cause.
      throw new Error(
        "this client is authenticated as an installation, which cannot list installations; " +
          "build it with GitHubClient.appOnly()",
      );
    }
    const { data } = await this.octokit.rest.apps.listInstallations({ per_page: 100 });
    return data.map((i) => ({
      id: i.id,
      // Both a User and an Organization carry `login`, and the field is nullable for
      // neither reason worth guessing at — an installation nobody can name is still an
      // installation, and crashing the listing would hide the others.
      account: (i.account as { login?: string } | null)?.login ?? "(unknown account)",
      repositorySelection: i.repository_selection === "all" ? "all" : "selected",
    }));
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
      commentable: commentableAnchors(files),
      cloneUrl: pr.base.repo.clone_url,
      htmlUrl: pr.html_url,
    };
  }

  /**
   * Open pull requests, each with the head SHA the list endpoint already returned.
   *
   * It used to return only `{owner, repo, number}`, throwing away the `head.sha` that came
   * back in the same response — and the poller then made one `getPullRequest` call per
   * pull request to fetch exactly that field again. N+1 requests per repository per tick,
   * for ever: fifty open pull requests on a sixty-second interval is 3060 requests an hour
   * against a limit of 5000, for data already in hand.
   *
   * Draft state comes back too, so the poller can skip drafts without asking either.
   */
  async listOpenPullRequests(
    owner: string,
    repo: string,
  ): Promise<(PullRequestRef & { headSha: string; draft: boolean })[]> {
    const prs = await this.octokit.paginate(this.octokit.rest.pulls.list, {
      owner,
      repo,
      state: "open",
      per_page: 100,
    });
    return prs.map((pr) => ({
      owner,
      repo,
      number: pr.number,
      headSha: pr.head.sha,
      draft: Boolean(pr.draft),
    }));
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
    } catch (err) {
      // 404 is the normal case — most repositories have no `.maestro.yaml`, and that is
      // not worth a log line. Anything else is a call that failed, and returning null for
      // it makes a broken request indistinguishable from an absent file: the repository's
      // own configuration silently stops applying and nothing says so. Found by calling
      // this with the wrong arguments during a live check and watching it report
      // "absent" for a request to `/repos///contents/maestro`.
      if ((err as { status?: number }).status !== 404) {
        logger.warn(
          { owner: pr.owner, repo: pr.repo, ref: pr.baseRef, path, err },
          "could not read the base branch config; continuing without it",
        );
      }
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
    } catch (err) {
      // Unknown rather than empty: an empty list would read as "nothing was addressed"
      // and silently settle nothing, which is the safer failure but a different claim.
      // Logged, because unlike a missing config file there is no ordinary reason for a
      // compare between two commits of the same repository to fail.
      logger.warn({ pr: pr.number, base, head, err }, "could not compare commits");
      return null;
    }
  }

  /**
   * Short-lived token for cloning. Never enters a container.
   *
   * The argument is not optional, and leaving it out broke the entire GitHub App path.
   * `octokit.auth()` with no options works for a personal token — the token strategy
   * simply hands back what it was given — but `@octokit/auth-app` reads `options.type`
   * and throws `Cannot read properties of undefined (reading 'type')` on the way past.
   * So every App-authenticated review failed before it cloned anything, with an error
   * naming neither GitHub nor authentication.
   *
   * It survived because every live test until now used `GITHUB_TOKEN`. The App is the
   * documented, preferred credential and the one the manifest flow creates, and it was
   * the branch nothing had ever executed.
   */
  async cloneToken(): Promise<string | undefined> {
    if (this.authKind === "token") {
      const auth = (await this.octokit.auth()) as { token?: string };
      return auth?.token;
    }
    // An App with no installation cannot mint an installation token at all. Returning
    // nothing lets the clone fail on a missing credential, which is the truth, rather
    // than throwing from inside a library on the way to finding that out.
    if (!this.installationId) return undefined;
    const auth = (await this.octokit.auth({
      type: "installation",
      installationId: this.installationId,
    })) as { token?: string };
    return auth?.token;
  }

  /**
   * Posts the consolidated summary as an issue comment.
   *
   * An issue comment on purpose, and not a pull request review carrying the summary in
   * its body. `findPreviousComment` searches issue comments, and `updateComment` is the
   * issues API — so a summary posted as a review would be invisible to the next round's
   * lookup and un-updatable by its id, and every push would add another full comment.
   * One comment per pull request, edited in place, is the whole anti-noise design.
   *
   * Anchored comments go through `postInlineComments`, separately, for that reason.
   */
  async postReview(
    pr: PullRequestContext,
    body: string,
  ): Promise<{ id: number; mode: "review" | "comment" }> {
    const { data } = await this.octokit.rest.issues.createComment({
      owner: pr.owner,
      repo: pr.repo,
      issue_number: pr.number,
      body,
    });
    return { id: data.id, mode: "comment" };
  }

  /**
   * Leaves anchored comments on the diff, as one review.
   *
   * Returns how many landed. A rejection is logged and dropped rather than retried or
   * degraded into another issue comment: the summary has already been posted and carries
   * every finding, so the cost of failing here is placement, not content. Falling back to
   * a second comment would double the thing the design exists to avoid.
   *
   * Callers filter anchors against the diff first — `createReview` rejects the whole
   * review over one bad line, so one unanchorable finding would otherwise cost all of
   * them.
   */
  async postInlineComments(
    pr: PullRequestContext,
    inline: InlineComment[],
  ): Promise<PostedInlineComment[]> {
    if (!inline.length) return [];
    try {
      const { data: review } = await this.octokit.rest.pulls.createReview({
        owner: pr.owner,
        repo: pr.repo,
        pull_number: pr.number,
        commit_id: pr.headSha,
        event: "COMMENT",
        // A review needs a body; this one deliberately says nothing a reader has to
        // read twice — the summary comment is the review.
        body: "Details and the metrics block are in the review comment on this pull request.",
        comments: inline.map((c) => ({
          path: c.path,
          line: c.line,
          body: c.body,
          side: "RIGHT",
        })),
      });

      // `createReview` answers with the review, not with its comments, and their ids are
      // what a later reaction has to be matched against. One extra listing per review with
      // any anchors at all, which is the price of a finding-level quality signal instead of
      // a review-level one.
      //
      // The pull request's comments filtered by review, rather than the review's own
      // comments, and the difference is not cosmetic: `listCommentsForReview` answers with
      // the legacy `position`-based representation, in which `line` and `original_line` are
      // *always* null, whatever Accept header is sent. This was that endpoint, read as
      // `c.line ?? 0`, so every comment came back anchored at line 0, matched no anchor in
      // `postAnchoredComments`, and was dropped — leaving the whole finding-level
      // attribution built on it doing nothing at all against real GitHub, while every stub
      // written from what the code expected passed. `scripts/live-github-check.mjs` pins
      // both halves: that the review-scoped endpoint omits the line, and that this one
      // carries it.
      //
      // `line` is still null here for a comment GitHub considers outdated — the line it
      // points at is no longer in the diff — and `original_line` is the one it was written
      // against, which is the anchor that was asked for.
      const posted = await this.octokit.paginate(this.octokit.rest.pulls.listReviewComments, {
        owner: pr.owner,
        repo: pr.repo,
        pull_number: pr.number,
        per_page: 100,
      });

      return posted
        .filter((c) => c.pull_request_review_id === review.id)
        .map((c) => ({ id: c.id, path: c.path, line: c.line ?? c.original_line ?? 0 }));
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), anchors: inline.length },
        "inline review rejected; the summary comment already carries every finding",
      );
      return [];
    }
  }

  /**
   * Who this credential posts as. Resolved once; a null means "could not tell".
   *
   * Kept separate from `identity()`, which is for humans reading `doctor` output. This one
   * is a security check and has to fail closed.
   */
  private selfAuthor?: { login?: string; appId?: number } | null;

  private async resolveSelfAuthor(): Promise<{ login?: string; appId?: number } | null> {
    if (this.selfAuthor !== undefined) return this.selfAuthor;
    try {
      if (this.authKind === "token") {
        const { data } = await this.octokit.rest.users.getAuthenticated();
        this.selfAuthor = { login: data.login };
      } else {
        // An installation token cannot ask who it is, but every comment it makes carries
        // the app that made it, and the app id is exactly what we hold.
        this.selfAuthor = { appId: this.appId ? Number(this.appId) : undefined };
        if (!this.selfAuthor.appId) this.selfAuthor = null;
      }
    } catch {
      this.selfAuthor = null;
    }
    return this.selfAuthor;
  }

  /**
   * Finds Maestro's own previous comment, so a re-review updates rather than piles on.
   *
   * The marker alone is not enough, and matching on it alone was a real hole. The marker
   * is a plain HTML comment visible in the source of every review Maestro posts, and on a
   * public repository anybody may comment on a pull request — so anybody could post
   * `<!-- maestro-review -->` and Maestro would write its review into *their* comment
   * instead of its own. The review would then be attributed to them and editable by them
   * afterwards, sitting exactly where a reviewer expects Maestro's output; `posted_comment_id`
   * would point at a comment Maestro does not own, so the reaction feedback that drives the
   * precision numbers would be collected from one an attacker controls; and placing the
   * marker before the first review would mean Maestro never posted a comment of its own at
   * all. The variable holding the matches was called `mine`, which is the assumption stated
   * out loud and never checked.
   *
   * So: marker AND author. If the author cannot be established, this returns null and the
   * caller posts a new comment — a duplicate comment is a nuisance, writing into a
   * stranger's is not.
   */
  async findPreviousComment(pr: PullRequestContext, marker: string): Promise<number | null> {
    const self = await this.resolveSelfAuthor();
    if (!self) {
      logger.warn(
        { pr: pr.number },
        "cannot establish which account Maestro posts as; posting a new comment rather than " +
          "risking an update to somebody else's",
      );
      return null;
    }

    const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      owner: pr.owner,
      repo: pr.repo,
      issue_number: pr.number,
      per_page: 100,
    });

    const mine = comments.filter((c) => {
      if (!(c.body ?? "").includes(marker)) return false;
      if (self.login) return c.user?.login === self.login;
      // App: the comment must have been made by this app's installation.
      return (
        (c as { performed_via_github_app?: { id?: number } }).performed_via_github_app?.id ===
        self.appId
      );
    });
    return mine.length ? (mine.at(-1)?.id ?? null) : null;
  }

  /**
   * Reactions on one comment, with who left them.
   *
   * Polled, not received: GitHub has no `reaction` webhook event — its event catalogue
   * lists none, and this project's own App manifest requests `pull_request`,
   * `issue_comment` and `pull_request_review_comment` because those are the ones that
   * exist. The daemon had a handler for a `reaction` event that could therefore never
   * fire, so the reaction half of the quality signal was built and unreachable.
   */
  /**
   * Reacts to the comment that asked for a review, so the asker knows they were heard.
   *
   * A review takes minutes. Until it posts, `@maestro review` produced nothing at all —
   * no reaction, no comment, no anything — which is indistinguishable from a bot that is
   * broken or was never installed. Observed on this project's own first live request: the
   * comment sat there for twelve minutes while three agents worked.
   *
   * Deliberately a reaction rather than a comment. One consolidated comment per pull
   * request is the whole anti-noise design, and a "working on it" comment would be the
   * first crack in it — a reaction is exactly as loud as an acknowledgement needs to be.
   *
   * Never throws. Failing to acknowledge a review must not stop it: the reaction is
   * courtesy, and the review is the point.
   */
  async reactToComment(pr: PullRequestRef, commentId: number, content: "eyes"): Promise<boolean> {
    try {
      await this.octokit.rest.reactions.createForIssueComment({
        owner: pr.owner,
        repo: pr.repo,
        comment_id: commentId,
        content,
      });
      return true;
    } catch (err) {
      logger.warn({ pr: pr.number, commentId, err }, "could not acknowledge the review request");
      return false;
    }
  }

  /**
   * Reactions on one comment Maestro left.
   *
   * The kind is required rather than inferred: an issue comment and a pull request review
   * comment are separate resources with separate endpoints and separate id sequences, so a
   * summary comment's id is usually also a valid review-comment id and asking the wrong
   * endpoint returns somebody else's reactions or a 404 — neither of which announces itself.
   */
  async listCommentReactions(
    pr: PullRequestRef,
    commentId: number,
    kind: PostedCommentKind = "summary",
  ): Promise<{ content: string; login?: string }[]> {
    const endpoint =
      kind === "inline"
        ? this.octokit.rest.reactions.listForPullRequestReviewComment
        : this.octokit.rest.reactions.listForIssueComment;
    const data = await this.octokit.paginate(endpoint, {
      owner: pr.owner,
      repo: pr.repo,
      comment_id: commentId,
      per_page: 100,
    });
    return data.map((r) => ({ content: r.content, login: r.user?.login ?? undefined }));
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
): Promise<{ mergeBase: boolean; mergeBaseSha: string | null }> {
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
    await run(["-C", dir, "fetch", "--quiet", "--depth", String(FETCH_DEPTH), "origin", ...wanted]);
  } catch {
    // A previous head may have been force-pushed away; the review still has to happen,
    // so fall back to the base and let the caller's diff degrade to a full review.
    await run([
      "-C",
      dir,
      "fetch",
      "--quiet",
      "--depth",
      String(FETCH_DEPTH),
      "origin",
      pr.headSha,
      pr.baseSha,
    ]);
  }
  await run(["-C", dir, "checkout", "--quiet", pr.headSha]);

  const mergeBaseSha = await ensureMergeBase(run, dir, pr);

  // Strip the credential so it cannot leak via .git/config into the container.
  await run(["-C", dir, "remote", "set-url", "origin", pr.cloneUrl]);

  return { mergeBase: mergeBaseSha !== null, mergeBaseSha };
}

/** Commits fetched initially. Enough for almost every pull request. */
const FETCH_DEPTH = 50;

/**
 * How far to deepen when the merge base is not in the shallow clone. Bounded on purpose:
 * a full history of a large monorepo, fetched inside a review, is its own outage.
 */
const DEEPEN_STEPS = [200, 1000];

/**
 * Makes sure the fork point is actually in the clone, deepening until it is.
 *
 * The agents' `git_diff` runs `base...HEAD` — the merge base — and falls back to
 * `base HEAD` when that fails. On a shallow clone the fork point is often missing, so the
 * fallback fires, and a two-point diff against the *current tip of the base branch*
 * attributes everything that landed on that branch since the fork to this pull request,
 * inverted: on a branch 60 commits behind, a one-line change was presented to every agent
 * as a one-line addition plus sixty deletions it never made. Measured, not reasoned about
 * — a local repository built to that shape produced exactly that diff.
 *
 * Nothing reported it. The fallback is a `||` inside a shell command; both halves exit 0.
 *
 * Returns null when the fork point is still missing after deepening, so the review can
 * say its diff is unreliable rather than quietly reviewing the wrong change.
 *
 * Returns the SHA rather than a boolean because the fork point is also the only defensible
 * baseline for running a command "before" the change. The base branch's tip is not: it
 * carries every commit that landed there since the fork, so a command measured against it
 * measures other people's work as well as this pull request's. This function already
 * computed the commit and threw it away.
 */
async function ensureMergeBase(
  run: (args: string[]) => Promise<{ stdout: string }>,
  dir: string,
  pr: PullRequestContext,
): Promise<string | null> {
  const found = async () => {
    try {
      const res = await run(["-C", dir, "merge-base", pr.baseSha, pr.headSha]);
      return res.stdout.trim() || null;
    } catch {
      return null;
    }
  };

  const first = await found();
  if (first) return first;

  for (const depth of DEEPEN_STEPS) {
    try {
      await run([
        "-C",
        dir,
        "fetch",
        "--quiet",
        "--deepen",
        String(depth),
        "origin",
        pr.headSha,
        pr.baseSha,
      ]);
    } catch {
      // A repository shallower than the step, or already complete. Ask again anyway.
    }
    const sha = await found();
    if (sha) {
      logger.info({ pr: pr.number, depth }, "deepened the clone to reach the fork point");
      return sha;
    }
  }

  logger.warn(
    { pr: pr.number, deepenedTo: DEEPEN_STEPS.at(-1) },
    "fork point not found after deepening; the diff will compare two points rather than " +
      "the change, and will include commits this pull request did not make",
  );
  return null;
}
