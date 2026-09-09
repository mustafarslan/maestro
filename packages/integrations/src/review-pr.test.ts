import { openStore } from "@maestro/core";
import { defaultPlaybook, PlaybookStore } from "@maestro/playbook";
import { describe, expect, it } from "vitest";
import type { GitHubClient } from "./github.js";
import { reviewPullRequest } from "./review-pr.js";

/**
 * Enough of a client to reach the point where the review row exists. Checkout fails
 * straight after, which is fine: what is under test is the ordering of `onStart`, and a
 * review that fails partway is exactly the case the daemon must still be able to cancel.
 */
function fakeClient(): GitHubClient {
  return {
    getPullRequest: async () => ({
      owner: "o",
      repo: "r",
      number: 7,
      title: "A change",
      body: "",
      author: "someone",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      baseRef: "main",
      isFork: false,
      changedFiles: ["src/index.ts"],
      changedLines: 10,
      draft: false,
    }),
    cloneToken: async () => {
      throw new Error("no network in this test");
    },
  } as unknown as GitHubClient;
}

describe("reviewPullRequest", () => {
  it("reports its review id before doing any long-running work", async () => {
    // The daemon registers its AbortController from this callback. Registering from the
    // return value instead — which is what it used to do — registers a review that has
    // already finished, so the in-flight map is empty at the exact moment a second push
    // needs to cancel something, and cancel-on-push can never fire.
    const db = await openStore({ path: ":memory:" });
    const playbook = defaultPlaybook();
    const version = new PlaybookStore(db).publish(playbook);

    const seen: { reviewId: string; headSha: string; prNumber: number }[] = [];
    await expect(
      reviewPullRequest({
        client: fakeClient(),
        db,
        deps: { driver: {} as never, registry: {} as never },
        playbook,
        playbookVersionId: version.id,
        pr: { owner: "o", repo: "r", number: 7 },
        dryRun: true,
        onStart: (info) => seen.push(info),
      }),
    ).rejects.toThrow(/no network/);

    // It fired before the failure — which is the case that most needs the caller to
    // have registered its controller, since a review that dies mid-flight still holds
    // containers and scheduler slots until something aborts it.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.prNumber).toBe(7);
    expect(seen[0]?.headSha).toBe("a".repeat(40));
    expect(seen[0]?.reviewId).toMatch(/^rv_/);
  });
});
