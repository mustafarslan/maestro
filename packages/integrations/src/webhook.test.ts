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
      // A real `issue_comment` delivery for a pull request carries `issue.pull_request`;
      // without it this is a comment on a plain issue, which is not reviewable.
      issue: { number: 12, pull_request: { url: "https://api.github.com/…/pulls/12" } },
      // The association matters now: a comment is anyone's to write, and a review costs
      // money. This test is about the command being recognised, so it comes from someone
      // allowed to ask.
      comment: {
        id: 900_001,
        body: "please take another look\n/maestro review",
        author_association: "COLLABORATOR",
      },
    });
    expect(t).toMatchObject({ kind: "review", pr: { number: 12 } });
  });

  it("ignores ordinary comments", () => {
    const t = interpretEvent("issue_comment", {
      action: "created",
      repository,
      // A real `issue_comment` delivery for a pull request carries `issue.pull_request`;
      // without it this is a comment on a plain issue, which is not reviewable.
      issue: { number: 12, pull_request: { url: "https://api.github.com/…/pulls/12" } },
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
  const comment = (bodyText: string, association = "MEMBER") =>
    interpretEvent("issue_comment", {
      action: "created",
      repository: { name: "web", owner: { login: "acme" } },
      issue: { number: 41, pull_request: { url: "https://api.github.com/…/pulls/41" } },
      comment: { id: 900_002, body: bodyText, author_association: association },
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
    // A real issue comment, with everything a real one has. The previous version of this
    // test omitted `issue` entirely, so it passed on a `!number` check that every issue
    // would have satisfied — it asserted the property in its title and tested a different
    // one. `issue.pull_request` is the discriminator, confirmed against the live API.
    const t = interpretEvent("issue_comment", {
      action: "created",
      repository: { name: "web", owner: { login: "acme" } },
      issue: { number: 41 },
      comment: { id: 1, body: "@maestro review", author_association: "OWNER" },
    });
    expect(t).toMatchObject({ kind: "ignore" });
  });

  it("accepts the same comment when the issue is a pull request", () => {
    const t = interpretEvent("issue_comment", {
      action: "created",
      repository: { name: "web", owner: { login: "acme" } },
      issue: { number: 41, pull_request: { url: "https://api.github.com/…/pulls/41" } },
      comment: { id: 1, body: "@maestro review", author_association: "OWNER" },
    });
    expect(t).toMatchObject({ kind: "review", pr: { number: 41 } });
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

describe("who may spend money asking for a review", () => {
  const from = (association: string) =>
    interpretEvent("issue_comment", {
      action: "created",
      repository: { name: "web", owner: { login: "acme" } },
      issue: { number: 41, pull_request: { url: "https://api.github.com/…/pulls/41" } },
      comment: { id: 900_003, body: "@maestro review", author_association: association },
    });

  it("accepts people with write access to the repository", () => {
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      expect(from(association).kind, association).toBe("review");
    }
  });

  it("refuses everyone else, because a review costs money", () => {
    // A comment is anyone's to write on a public repository, and a review starts
    // containers and bills model calls. Without this, any passer-by could run up a bill
    // by commenting, repeatedly.
    for (const association of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE", "MANNEQUIN"]) {
      expect(from(association).kind, association).toBe("ignore");
    }
  });

  it("refuses a comment with no association at all", () => {
    // A payload shape we do not recognise must not be treated as authorised.
    const t = interpretEvent("issue_comment", {
      action: "created",
      repository: { name: "web", owner: { login: "acme" } },
      issue: { number: 41 },
      comment: { body: "@maestro review" },
    });
    expect(t.kind).toBe("ignore");
  });

  it("says why, so the refusal is diagnosable", () => {
    const t = from("NONE");
    expect(t.reason).toContain("NONE");
  });

  it("does not gate the automatic triggers", () => {
    // Those come from the pull request's own lifecycle, not from someone commenting.
    const t = interpretEvent("pull_request", {
      action: "opened",
      repository: { name: "web", owner: { login: "acme" } },
      pull_request: { number: 7, head: { sha: "a".repeat(40) } },
    });
    expect(t.kind).toBe("review");
  });
});

describe("a requested review carries the comment that asked for it", () => {
  // The daemon deduplicates on this. Without an id every request on a pull request
  // collapses onto one key that is never released, so the second `@maestro review`
  // silently does nothing — including after the first review has finished.
  const comment = (id: unknown) =>
    interpretEvent("issue_comment", {
      action: "created",
      repository: { name: "web", owner: { login: "acme" } },
      issue: { number: 41, pull_request: { url: "https://api.github.com/…/pulls/41" } },
      comment: { id, body: "@maestro review", author_association: "OWNER" },
    });

  it("reports the id", () => {
    expect(comment(778_899)).toMatchObject({
      kind: "review",
      source: "comment",
      commentId: 778_899,
    });
  });

  it("ignores a delivery with no id rather than reviewing undeduplicated", () => {
    expect(comment(undefined)).toMatchObject({ kind: "ignore" });
  });
});

describe("the poller asks once per repository, not once per pull request", () => {
  // N+1 per repository per tick, for ever: the head SHA arrives with the listing and the
  // poller used to discard it, then fetch each pull request individually for exactly that
  // field. Fifty open pull requests on a sixty-second interval is 3060 requests an hour
  // against a limit of 5000 — and it degrades as a repository gets busier, which is when
  // reviews matter most. Verified against the live API: `pulls.list` returns a 40-character
  // head SHA and a boolean draft for every entry.
  it("uses the head sha the listing already carried", () => {
    const state = newPollState();
    const triggers = diffPoll(state, [
      { pr: { owner: "acme", repo: "web", number: 7 }, headSha: "a".repeat(40) },
    ]);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({ kind: "review", headSha: "a".repeat(40) });
  });

  it("still says nothing when the head has not moved", () => {
    const state = newPollState();
    const observed = [{ pr: { owner: "acme", repo: "web", number: 7 }, headSha: "b".repeat(40) }];
    diffPoll(state, observed);
    expect(diffPoll(state, observed)).toHaveLength(0);
  });
});
