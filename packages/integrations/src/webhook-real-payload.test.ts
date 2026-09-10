import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { interpretEvent, verifySignature } from "./webhook.js";

/**
 * A payload GitHub composed, not one this project invented.
 *
 * Every other webhook test in this repository builds its own payload, which means they
 * all share one assumption: that the shape imagined here is the shape GitHub sends. This
 * one came off a real repository webhook's delivery log — `pull_request.opened` for a
 * pull request opened for the purpose, 22KB of it — and is kept so that assumption stays
 * checked rather than inherited.
 *
 * The signature half was verified live at the same time and is not reproducible here: the
 * hook and its secret were deleted afterwards, and a stored signature over a stored body
 * proves only that HMAC is deterministic. What was actually established, against a running
 * listener, was that GitHub's own `X-Hub-Signature-256` over GitHub's own bytes is
 * accepted, and that the same signature over a body with one word changed is refused with
 * a 401.
 */
const payload = JSON.parse(
  readFileSync(join(import.meta.dirname, "__fixtures__/github-pull-request-opened.json"), "utf8"),
);

describe("GitHub's own pull_request payload", () => {
  it("is read as a review trigger for the right pull request", () => {
    const trigger = interpretEvent("pull_request", payload);
    expect(trigger).toMatchObject({
      kind: "review",
      reason: "pull_request.opened",
      pr: { owner: "mustafarslan", repo: "maestro", number: 3 },
      headSha: "983b2c089477e8cc639ce36e7df29a789baef2cf",
    });
  });

  it("is treated as a lifecycle trigger, so automatic review can be turned off", () => {
    // A repository that has opted out of reviewing every pull request must not be
    // reviewed because the payload arrived by webhook rather than by poll.
    expect(interpretEvent("pull_request", payload)).toMatchObject({ source: "lifecycle" });
  });

  it("reads the head SHA from the pull request, not from the repository", () => {
    // The payload carries several SHAs — base, merge_commit, the repository's default
    // branch. Picking the wrong one reviews the wrong code and breaks idempotency, and
    // an invented fixture is exactly where that would go unnoticed.
    const trigger = interpretEvent("pull_request", payload);
    expect(trigger).toMatchObject({ headSha: payload.pull_request.head.sha });
    expect((trigger as { headSha?: string }).headSha).not.toBe(payload.pull_request.base.sha);
  });

  it("refuses a delivery with no signature", async () => {
    expect(await verifySignature("secret", JSON.stringify(payload), undefined)).toBe(false);
  });
});
