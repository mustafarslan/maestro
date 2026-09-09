import { describe, expect, it } from "vitest";
import { anchorKey, inlineComments } from "./inline.js";
import type { TriagedFinding } from "./triage.js";

const finding = (over: Partial<TriagedFinding>): TriagedFinding =>
  ({
    agentIds: ["security"],
    agreementCount: 1,
    dedupeGroup: "g",
    category: "bug",
    severity: "high",
    confidence: 0.9,
    title: "t",
    body: "b",
    ...over,
  }) as TriagedFinding;

const diff = new Map([["src/a.ts", new Set([10, 11, 12])]]);

describe("anchoring a comment to a line", () => {
  it("keeps a finding whose line is in the diff", () => {
    const out = inlineComments([finding({ file: "src/a.ts", lineStart: 11 })], diff, { cap: 15 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ path: "src/a.ts", line: 11 });
  });

  it("drops a finding anchored outside the diff", () => {
    // The one that matters: `createReview` rejects the WHOLE review over a single bad
    // anchor, so one finding on an unchanged line would cost every other comment.
    expect(
      inlineComments([finding({ file: "src/a.ts", lineStart: 99 })], diff, { cap: 15 }),
    ).toEqual([]);
  });

  it("drops a finding in a file with no patch", () => {
    expect(
      inlineComments([finding({ file: "logo.png", lineStart: 1 })], diff, { cap: 15 }),
    ).toEqual([]);
  });

  it("drops a whole-PR finding, which has nowhere to go", () => {
    expect(inlineComments([finding({ lineStart: 11 })], diff, { cap: 15 })).toEqual([]);
  });

  it("falls back to the end of the passage when the start is not in the diff", () => {
    const out = inlineComments([finding({ file: "src/a.ts", lineStart: 8, lineEnd: 12 })], diff, {
      cap: 15,
    });
    expect(out[0]?.line).toBe(12);
  });

  it("does not repeat a comment an earlier round already left", () => {
    // A review re-runs on every push and a carried finding is still true. Posting it
    // again each time is the repetition that makes people mute a reviewer.
    const f = finding({ file: "src/a.ts", lineStart: 11 });
    expect(
      inlineComments([f], diff, { cap: 15, already: new Set([anchorKey("src/a.ts", 11)]) }),
    ).toEqual([]);
  });

  it("honours the cap", () => {
    const many = [10, 11, 12].map((n) => finding({ file: "src/a.ts", lineStart: n }));
    expect(inlineComments(many, diff, { cap: 2 })).toHaveLength(2);
  });

  it("escapes the body it builds", () => {
    // Built through render.ts on purpose: assembling one here by concatenation would
    // reopen the markdown injection the summary comment was hardened against.
    const out = inlineComments(
      [finding({ file: "src/a.ts", lineStart: 11, body: "ping @octocat\n## Approved" })],
      diff,
      { cap: 15 },
    );
    expect(out[0]?.body).not.toContain("@octocat");
    expect(out[0]?.body).not.toMatch(/^## Approved/m);
  });
});
