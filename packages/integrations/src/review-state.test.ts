import { openStore, ReviewStore, type SqlDatabase } from "@maestro/core";
import type { ReviewOutcome } from "@maestro/engine";
import { defaultPlaybook, PlaybookStore } from "@maestro/playbook";
import { beforeEach, describe, expect, it } from "vitest";
import {
  GitHubClient,
  type PullRequestContext,
  REVIEW_STATE_MARKER,
  type ReviewStateResult,
} from "./github.js";
import { settleReviewState } from "./review-pr.js";

/**
 * Setting the review state a developer profile chose.
 *
 * The GitHub half is exercised against a fake octokit, because the question is what Maestro
 * asks for and what it refuses to touch; `scripts/live-github-check.mjs --write` is where the
 * request shapes meet the real API.
 */

const pr = {
  owner: "acme",
  repo: "web",
  number: 7,
  headSha: "a".repeat(40),
} as unknown as PullRequestContext;

function client(
  rest: Record<string, unknown>,
  self: { login?: string } | null = { login: "maestro-bot" },
) {
  const c = new GitHubClient({ kind: "token", token: "t" });
  const calls: { name: string; params: Record<string, unknown> }[] = [];
  const record =
    (name: string, fn: (p: Record<string, unknown>) => unknown) =>
    async (params: Record<string, unknown>) => {
      calls.push({ name, params });
      return fn(params);
    };
  const pulls = Object.fromEntries(
    Object.entries(rest).map(([k, fn]) => [
      k,
      record(k, fn as (p: Record<string, unknown>) => unknown),
    ]),
  );
  (c as unknown as { octokit: unknown }).octokit = {
    rest: {
      pulls,
      users: {
        getAuthenticated: async () => {
          if (!self) throw new Error("installation tokens cannot ask");
          return { data: self };
        },
      },
    },
    paginate: async (
      fn: (p: Record<string, unknown>) => Promise<{ data: unknown }>,
      params: Record<string, unknown>,
    ) => (await fn(params)).data,
  };
  return { c, calls };
}

describe("GitHubClient.submitReviewState", () => {
  it("blocking submits a REQUEST_CHANGES review at the head, carrying the marker", async () => {
    const { c, calls } = client({ createReview: () => ({ data: { id: 99 } }) });
    const result = await c.submitReviewState(pr, "REQUEST_CHANGES", "two findings block");
    expect(result).toEqual({ outcome: "requested", reviewId: 99, dismissed: [] });
    expect(calls[0]?.params).toMatchObject({
      owner: "acme",
      repo: "web",
      pull_number: 7,
      commit_id: "a".repeat(40),
      event: "REQUEST_CHANGES",
    });
    expect(String(calls[0]?.params.body)).toBe(`${REVIEW_STATE_MARKER}\ntwo findings block`);
  });

  it("a pull request opened by the posting account is refused by GitHub, and reported, not thrown", async () => {
    const { c } = client({
      createReview: () => {
        throw Object.assign(
          new Error(
            "Unprocessable Entity: Review Can not request changes on your own pull request",
          ),
          { status: 422 },
        );
      },
    });
    const result = await c.submitReviewState(pr, "REQUEST_CHANGES", "x");
    expect(result.outcome).toBe("refused");
    expect(result.reason).toBe(
      "GitHub does not let an account request changes on its own pull request",
    );
  });

  it("any other failure throws, for the caller to log", async () => {
    const { c } = client({
      createReview: () => {
        throw Object.assign(new Error("Bad credentials"), { status: 401 });
      },
    });
    await expect(c.submitReviewState(pr, "REQUEST_CHANGES", "x")).rejects.toThrow(
      /Bad credentials/,
    );
  });

  it("not blocking dismisses Maestro's own earlier blocks, and nobody else's", async () => {
    const reviews = [
      {
        id: 1,
        state: "CHANGES_REQUESTED",
        user: { login: "maestro-bot" },
        body: `${REVIEW_STATE_MARKER}\nold`,
      },
      // A person who quoted the marker: never dismissed.
      {
        id: 2,
        state: "CHANGES_REQUESTED",
        user: { login: "ada" },
        body: `see ${REVIEW_STATE_MARKER}`,
      },
      // Maestro's, but not a block.
      { id: 3, state: "COMMENTED", user: { login: "maestro-bot" }, body: REVIEW_STATE_MARKER },
      // Maestro's account, but not a state review Maestro submitted.
      { id: 4, state: "CHANGES_REQUESTED", user: { login: "maestro-bot" }, body: "by hand" },
    ];
    const { c, calls } = client({
      listReviews: () => ({ data: reviews }),
      dismissReview: () => ({ data: {} }),
    });
    const result = await c.submitReviewState(pr, "COMMENT", "unused");
    expect(result).toEqual({ outcome: "none", dismissed: [1] });
    expect(calls.filter((x) => x.name === "dismissReview").map((x) => x.params.review_id)).toEqual([
      1,
    ]);
  });

  it("an App learns its login from the block it placed, and can lift it", async () => {
    const reviews = [
      {
        id: 9,
        state: "CHANGES_REQUESTED",
        user: { login: "maestro[bot]" },
        body: `${REVIEW_STATE_MARKER}\nx`,
      },
    ];
    const { c, calls } = client(
      {
        createReview: () => ({ data: { id: 9, user: { login: "maestro[bot]" } } }),
        listReviews: () => ({ data: reviews }),
        dismissReview: () => ({ data: {} }),
      },
      null,
    );
    // Installation tokens cannot ask who they are, and hold no app id in this fake either.
    (c as unknown as { authKind: string }).authKind = "app";
    await c.submitReviewState(pr, "REQUEST_CHANGES", "blocked");
    const lifted = await c.submitReviewState(pr, "COMMENT", "");
    expect(lifted.dismissed).toEqual([9]);
    expect(calls.map((x) => x.name)).toEqual(["createReview", "listReviews", "dismissReview"]);
  });

  it("dismisses nothing when it cannot establish which account it posts as", async () => {
    const { c, calls } = client({ listReviews: () => ({ data: [] }) }, null);
    const result = await c.submitReviewState(pr, "COMMENT", "unused");
    expect(result.outcome).toBe("none");
    expect(result.reason).toMatch(/cannot establish which account/);
    expect(calls).toHaveLength(0);
  });
});

describe("settleReviewState", () => {
  let db: SqlDatabase;
  let reviews: ReviewStore;
  let versionId: string;

  beforeEach(async () => {
    db = await openStore({ path: ":memory:" });
    versionId = new PlaybookStore(db).publish(defaultPlaybook()).id;
    reviews = new ReviewStore(db);
  });

  const round = (sha: string) =>
    reviews.create({
      repoOwner: "acme",
      repoName: "web",
      prNumber: 7,
      headSha: sha,
      playbookVersionId: versionId,
    }).id;

  const outcome = (state?: "REQUEST_CHANGES" | "COMMENT"): ReviewOutcome =>
    ({
      reviewId: "rv",
      state: "done",
      nodes: [],
      costCents: 0,
      durationMs: 1,
      allowedCommands: [],
      egressLog: [],
      triage: {
        posted: [],
        suppressed: [],
        summary: "",
        ...(state
          ? {
              personalization: {
                subject: "octocat",
                batteryVersion: "2.2",
                state,
                politenessTags: false,
                dropped: 0,
              },
            }
          : {}),
      },
    }) as unknown as ReviewOutcome;

  function fake(result: ReviewStateResult) {
    const asked: string[] = [];
    return {
      asked,
      client: {
        submitReviewState: async (_pr: PullRequestContext, state: string) => {
          asked.push(state);
          return result;
        },
      },
    };
  }
  const postedState = (id: string) =>
    db
      .prepare("SELECT posted_state FROM reviews WHERE id=?")
      .get<{ posted_state: string | null }>(id)?.posted_state;

  it("does nothing for a review with no profile and no earlier block", async () => {
    const { client: c, asked } = fake({ outcome: "none", dismissed: [] });
    const id = round("a1");
    expect(await settleReviewState(c, db, pr, id, outcome())).toBeUndefined();
    expect(asked).toEqual([]);
    expect(postedState(id)).toBeNull();
  });

  it("sets the profile's state and records it", async () => {
    const { client: c, asked } = fake({ outcome: "requested", reviewId: 5, dismissed: [] });
    const id = round("a1");
    await settleReviewState(c, db, pr, id, outcome("REQUEST_CHANGES"));
    expect(asked).toEqual(["REQUEST_CHANGES"]);
    expect(postedState(id)).toBe("REQUEST_CHANGES");
  });

  it("a refused block is recorded as no block", async () => {
    const { client: c } = fake({ outcome: "refused", dismissed: [], reason: "own pull request" });
    const id = round("a1");
    await settleReviewState(c, db, pr, id, outcome("REQUEST_CHANGES"));
    expect(postedState(id)).toBe("COMMENT");
  });

  it("a later round without a profile lifts a block an earlier round placed", async () => {
    const first = round("a1");
    await settleReviewState(
      fake({ outcome: "requested", dismissed: [] }).client,
      db,
      pr,
      first,
      outcome("REQUEST_CHANGES"),
    );

    const second = round("a2");
    const { client: c, asked } = fake({ outcome: "none", dismissed: [1] });
    await settleReviewState(c, db, pr, second, outcome());
    expect(asked).toEqual(["COMMENT"]);
    expect(postedState(second)).toBe("COMMENT");

    // Lifted once is enough: the round after that has nothing to lift.
    const third = round("a3");
    const again = fake({ outcome: "none", dismissed: [] });
    await settleReviewState(again.client, db, pr, third, outcome());
    expect(again.asked).toEqual([]);
  });

  it("a profile that does not block asks GitHub nothing when there is no block to lift", async () => {
    const { client: c, asked } = fake({ outcome: "none", dismissed: [] });
    expect(await settleReviewState(c, db, pr, round("a1"), outcome("COMMENT"))).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it("a failed review sets no state", async () => {
    const { client: c, asked } = fake({ outcome: "requested", dismissed: [] });
    const failed = { ...outcome("REQUEST_CHANGES"), state: "failed" } as ReviewOutcome;
    expect(await settleReviewState(c, db, pr, round("a1"), failed)).toBeUndefined();
    expect(asked).toEqual([]);
  });
});
