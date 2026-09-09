import { describe, expect, it } from "vitest";
import { diffPoll, interpretEvent, newPollState, verifySignature } from "./webhook.js";

const repository = { name: "web", owner: { login: "acme" } };

describe("webhook signature", () => {
  it("accepts a correctly signed payload and rejects tampering", async () => {
    // This endpoint is the one part of Maestro exposed to the internet; an unsigned
    // payload is an attacker asking us to review a repository of their choosing.
    const secret = "s3cret";
    const body = JSON.stringify({ hello: "world" });
    const { sign } = await import("@octokit/webhooks-methods");
    const signature = await sign(secret, body);

    expect(await verifySignature(secret, body, signature)).toBe(true);
    expect(await verifySignature(secret, `${body} `, signature)).toBe(false);
    expect(await verifySignature("wrong", body, signature)).toBe(false);
    expect(await verifySignature(secret, body, undefined)).toBe(false);
  });
});

describe("event interpretation", () => {
  const pr = (over: Record<string, unknown> = {}) => ({
    action: "opened",
    repository,
    pull_request: { number: 5, head: { sha: "abc123" }, ...over },
  });

  it("reviews an opened pull request", () => {
    const t = interpretEvent("pull_request", pr());
    expect(t).toMatchObject({
      kind: "review",
      headSha: "abc123",
      pr: { owner: "acme", repo: "web", number: 5 },
    });
  });

  it("reviews a new push to an existing pull request", () => {
    const t = interpretEvent("pull_request", { ...pr(), action: "synchronize" });
    expect(t.kind).toBe("review");
  });

  it("ignores a draft pull request", () => {
    expect(interpretEvent("pull_request", pr({ draft: true })).kind).toBe("ignore");
  });

  it("reviews a draft once it is marked ready", () => {
    const t = interpretEvent("pull_request", { ...pr(), action: "ready_for_review" });
    expect(t.kind).toBe("review");
  });

  it("ignores actions that change nothing about whether to review", () => {
    // `closed` was in this list and is not: a closed pull request should stop a review
    // that is still running, not be shrugged at.
    for (const action of ["labeled", "assigned", "edited"]) {
      expect(interpretEvent("pull_request", { ...pr(), action }).kind, action).toBe("ignore");
    }
  });

  it("honours an explicit /maestro review comment", () => {
    const t = interpretEvent("issue_comment", {
      action: "created",
      repository,
      issue: { number: 12 },
      comment: { body: "please take another look\n/maestro review" },
    });
    expect(t).toMatchObject({ kind: "review", pr: { number: 12 } });
  });

  it("ignores ordinary comments", () => {
    const t = interpretEvent("issue_comment", {
      action: "created",
      repository,
      issue: { number: 12 },
      comment: { body: "looks good to me" },
    });
    expect(t.kind).toBe("ignore");
  });

  it("ignores an event with no repository rather than guessing", () => {
    expect(interpretEvent("pull_request", { action: "opened" }).kind).toBe("ignore");
  });
});

describe("poll mode", () => {
  const ref = (number: number) => ({ owner: "acme", repo: "web", number });

  it("triggers on a newly seen pull request", () => {
    const state = newPollState();
    const triggers = diffPoll(state, [{ pr: ref(1), headSha: "aaa" }]);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.reason).toContain("new pull request");
  });

  it("does not re-trigger when nothing changed", () => {
    // Polling every minute must not re-review the same commit sixty times an hour.
    const state = newPollState();
    diffPoll(state, [{ pr: ref(1), headSha: "aaa" }]);
    expect(diffPoll(state, [{ pr: ref(1), headSha: "aaa" }])).toHaveLength(0);
  });

  it("triggers again when the head sha moves", () => {
    const state = newPollState();
    diffPoll(state, [{ pr: ref(1), headSha: "aaa" }]);
    const triggers = diffPoll(state, [{ pr: ref(1), headSha: "bbb" }]);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.reason).toContain("new head sha");
  });

  it("forgets closed pull requests so a long-lived daemon does not grow unbounded", () => {
    const state = newPollState();
    diffPoll(state, [
      { pr: ref(1), headSha: "aaa" },
      { pr: ref(2), headSha: "bbb" },
    ]);
    diffPoll(state, [{ pr: ref(1), headSha: "aaa" }]);
    expect(state.seen.size).toBe(1);
  });
});

describe("triggering a review from a comment", () => {
  const comment = (bodyText: string) =>
    interpretEvent("issue_comment", {
      action: "created",
      repository: { name: "web", owner: { login: "acme" } },
      issue: { number: 41 },
      comment: { body: bodyText },
    });

  it("accepts the mention form, which is what @claude taught people to expect", () => {
    const t = comment("@maestro review it please");
    expect(t.kind).toBe("review");
    if (t.kind === "review") expect(t.pr).toMatchObject({ owner: "acme", repo: "web", number: 41 });
  });

  it("still accepts the slash form", () => {
    expect(comment("/maestro review").kind).toBe("review");
  });

  it("finds the command on a later line of a longer comment", () => {
    // People write a sentence and then the command.
    expect(comment("Looks good to me.\n\n@maestro review").kind).toBe("review");
  });

  it("ignores a comment that merely mentions maestro", () => {
    // A discussion about the tool must not start a run that costs money.
    expect(comment("we should get maestro to review this someday").kind).toBe("ignore");
    expect(comment("@maestro is being noisy lately").kind).toBe("ignore");
  });

  it("ignores a comment on an issue that is not a pull request", () => {
    const t = interpretEvent("issue_comment", {
      action: "created",
      repository: { name: "web", owner: { login: "acme" } },
      comment: { body: "@maestro review" },
    });
    expect(t.kind).toBe("ignore");
  });
});

describe("pull requests that stop being worth reviewing", () => {
  const prEvent = (action: string) =>
    interpretEvent("pull_request", {
      action,
      repository: { name: "web", owner: { login: "acme" } },
      pull_request: { number: 7, head: { sha: "a".repeat(40) } },
    });

  it("cancels the review when the pull request is closed", () => {
    // Otherwise it runs to completion, holding containers for several minutes to produce
    // a comment on a closed pull request. `cancel` was declared in the trigger union for
    // this and nothing ever constructed it.
    const t = prEvent("closed");
    expect(t.kind).toBe("cancel");
    if (t.kind === "cancel") expect(t.pr).toMatchObject({ owner: "acme", repo: "web", number: 7 });
  });

  it("cancels when a pull request goes back to draft", () => {
    expect(prEvent("converted_to_draft").kind).toBe("cancel");
  });

  it("still ignores actions that change nothing, like a label", () => {
    expect(prEvent("labeled").kind).toBe("ignore");
  });

  it("still reviews the actions that should start one", () => {
    for (const action of ["opened", "reopened", "ready_for_review", "synchronize"]) {
      expect(prEvent(action).kind, `${action} should trigger a review`).toBe("review");
    }
  });
});
