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

/**
 * Whose comment Maestro is allowed to overwrite.
 *
 * The marker is a plain HTML comment, visible in the source of every review Maestro
 * posts, and on a public repository anybody may comment on a pull request. Matching on
 * it alone meant anybody could claim Maestro's comment slot.
 */
describe("finding Maestro's own previous comment", () => {
  const MARKER = "<!-- maestro-review -->";
  const listing = (comments: unknown[]) => ({
    users: { getAuthenticated: async () => ({ data: { login: "maestro-bot" } }) },
    issues: { listComments: () => ({}) },
    __comments: comments,
  });
  const client = (comments: unknown[], rest = listing(comments)) => {
    const c = new GitHubClient({ kind: "token", token: "t" });
    (c as unknown as { octokit: unknown }).octokit = {
      rest,
      paginate: async () => comments,
    };
    return c;
  };

  it("finds its own comment", async () => {
    const c = client([{ id: 1, body: `${MARKER}\nreview`, user: { login: "maestro-bot" } }]);
    await expect(c.findPreviousComment(pr, MARKER)).resolves.toBe(1);
  });

  it("refuses a stranger's comment carrying the marker", async () => {
    // Otherwise the review is written into their comment: attributed to them, editable by
    // them afterwards, sitting where a reviewer expects Maestro's output — and the
    // reaction feedback that drives the precision numbers is then collected from a
    // comment an attacker controls.
    const c = client([
      { id: 9, body: `${MARKER}\nnothing to see here`, user: { login: "drive-by" } },
    ]);
    await expect(c.findPreviousComment(pr, MARKER)).resolves.toBeNull();
  });

  it("picks its own even when a stranger placed the marker first", async () => {
    const c = client([
      { id: 9, body: `${MARKER}\nsquatted`, user: { login: "drive-by" } },
      { id: 10, body: `${MARKER}\nthe real one`, user: { login: "maestro-bot" } },
    ]);
    await expect(c.findPreviousComment(pr, MARKER)).resolves.toBe(10);
  });

  it("posts a new comment rather than guessing when it cannot tell who it is", async () => {
    // Fail closed. A duplicate comment is a nuisance; writing into a stranger's is not.
    const c = client([{ id: 1, body: MARKER, user: { login: "maestro-bot" } }], {
      users: {
        getAuthenticated: async () => {
          throw new Error("network down");
        },
      },
    } as never);
    await expect(c.findPreviousComment(pr, MARKER)).resolves.toBeNull();
  });

  it("ignores its own comments that do not carry the marker", async () => {
    const c = client([{ id: 1, body: "just chatting", user: { login: "maestro-bot" } }]);
    await expect(c.findPreviousComment(pr, MARKER)).resolves.toBeNull();
  });
});

/**
 * The comment ids a review just left, and the line each one is anchored at.
 *
 * Against real GitHub this returned nothing usable. `listCommentsForReview` answers with
 * the legacy `position`-based representation, in which `line` and `original_line` are
 * always null — checked on `nodejs/node#65945`, where comment 3971215310 reads
 * `line: 46` from the pull request's own comment list and `line: null` from its review's,
 * under every Accept header. Read as `c.line ?? 0`, every comment was anchored at line 0,
 * matched no anchor in `postAnchoredComments`, and was dropped, so the finding-level
 * attribution the whole feedback signal rests on quietly did nothing.
 *
 * No stub produced that shape, because the stubs were written from what the code
 * expected. So: the pull request's comments filtered by review id, and `original_line`
 * where `line` is null, which is the outdated case that endpoint really does have.
 */
describe("the ids of the comments a review just left", () => {
  const withPaginate = (rows: unknown[]): GitHubClient => {
    const client = new GitHubClient({ kind: "token", token: "t" });
    Object.assign(client as unknown as { octokit: unknown }, {
      octokit: {
        rest: {
          pulls: {
            createReview: async () => ({ data: { id: 99 } }),
            listReviewComments: () => undefined,
          },
        },
        paginate: async () => rows,
      },
    });
    return client;
  };

  const anchors = [{ path: "src/a.ts", line: 4, body: "b", dedupeGroup: "g" }];
  const prRef = { owner: "acme", repo: "web", number: 1, headSha: "abc" } as never;

  it("falls back to the line an outdated comment was written against", async () => {
    const client = withPaginate([
      { id: 7, path: "src/a.ts", line: null, original_line: 4, pull_request_review_id: 99 },
    ]);
    await expect(client.postInlineComments(prRef, anchors)).resolves.toEqual([
      { id: 7, path: "src/a.ts", line: 4 },
    ]);
  });

  it("prefers the current line when GitHub gives one", async () => {
    const client = withPaginate([
      { id: 7, path: "src/a.ts", line: 9, original_line: 4, pull_request_review_id: 99 },
    ]);
    await expect(client.postInlineComments(prRef, anchors)).resolves.toEqual([
      { id: 7, path: "src/a.ts", line: 9 },
    ]);
  });

  it("still yields 0 when neither field is there, rather than undefined", async () => {
    // 0 matches no anchor, which is the correct outcome for a comment that cannot be
    // placed — `undefined` would key as "src/a.ts:undefined" and read as a real anchor.
    const client = withPaginate([
      { id: 7, path: "src/a.ts", line: null, pull_request_review_id: 99 },
    ]);
    await expect(client.postInlineComments(prRef, anchors)).resolves.toEqual([
      { id: 7, path: "src/a.ts", line: 0 },
    ]);
  });
  it("keeps only the comments this review left", async () => {
    // The listing is the pull request's, not the review's, so an earlier round's comments
    // come back with it. Attributing one of those would write a stale id onto a finding.
    const client = withPaginate([
      { id: 6, path: "src/a.ts", line: 4, pull_request_review_id: 12 },
      { id: 7, path: "src/a.ts", line: 4, pull_request_review_id: 99 },
    ]);
    await expect(client.postInlineComments(prRef, anchors)).resolves.toEqual([
      { id: 7, path: "src/a.ts", line: 4 },
    ]);
  });
});
