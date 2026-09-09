import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commentableAnchors, commentableLines } from "./patch.js";

// A real two-hunk patch. The second hunk's header is what a naive parser gets wrong:
// the RIGHT-side start is not the LEFT-side start, and deletions must not advance it.
const PATCH = [
  "@@ -1,4 +1,5 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " const d = 5;",
  " ",
  "@@ -20,3 +21,3 @@ function x() {",
  " keep",
  "-gone",
  "+added",
].join("\n");

describe("which lines can carry a comment", () => {
  it("counts additions and context, never deletions", () => {
    // Hunk one starts at 1: context 1, then the two additions 2 and 3, then context 4
    // and the blank context line 5. The deleted line consumed no right-side number.
    expect([...commentableLines(PATCH)]).toEqual([1, 2, 3, 4, 5, 21, 22]);
  });

  it("reads the right-side start of each hunk, not the left", () => {
    // `-20` and `+21` differ on purpose: a parser that used the left number would put
    // every comment in the second hunk one line off, which GitHub accepts silently
    // whenever line 20 also happens to be in the diff.
    expect(commentableLines(PATCH).has(21)).toBe(true);
    expect(commentableLines(PATCH).has(20)).toBe(false);
  });

  it("treats a file with no patch as having no anchors", () => {
    // GitHub omits `patch` for binary files and for ones too large to render. That is
    // "nowhere to anchor", not an error.
    expect(commentableLines(undefined).size).toBe(0);
    expect(commentableAnchors([{ filename: "logo.png" }]).size).toBe(0);
  });

  it("ignores the no-newline marker, which is not a line", () => {
    const p = ["@@ -1,1 +1,1 @@", "+one", "\\ No newline at end of file"].join("\n");
    expect([...commentableLines(p)]).toEqual([1]);
  });

  it("ignores anything before the first hunk header", () => {
    const p = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,1 +7,1 @@", "+seven"].join("\n");
    expect([...commentableLines(p)]).toEqual([7]);
  });
});

describe("a patch GitHub actually sent", () => {
  /**
   * The synthetic patches above were written by the same person who wrote the parser,
   * which is the weakness they share. This one came off `pulls.listFiles` for a real pull
   * request on this repository — three hunks, 86 lines — and is kept as a fixture so the
   * parser keeps being checked against GitHub's own output rather than only against a
   * shape somebody imagined.
   *
   * The expected set was computed live by a second, independently written walk of the same
   * patch, and the two agreed on all 81 anchors before this was written down.
   */
  const patch = readFileSync(join(import.meta.dirname, "__fixtures__/real-pr-patch.txt"), "utf8");

  it("finds every hunk's right-side start", () => {
    const lines = commentableLines(patch);
    for (const m of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)/gm)) {
      expect(lines.has(Number(m[1])), `hunk starting at ${m[1]}`).toBe(true);
    }
  });

  it("anchors exactly the lines that exist in the head revision", () => {
    // Every addition and context line advances the right-side counter; deletions do not.
    // Counted from the patch itself rather than restated as a number, so the assertion
    // does not become a copy of the implementation's answer.
    const body = patch.split("\n").filter((l) => /^@@ /.test(l) === false);
    const rightSide = body.filter(
      (l) => !l.startsWith("-") && !l.startsWith("\\") && l.length > 0,
    ).length;
    expect(commentableLines(patch).size).toBe(rightSide);
  });

  it("never anchors past the end of the last hunk", () => {
    const lines = [...commentableLines(patch)];
    const lastHunk = [...patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))?/gm)].at(-1);
    const start = Number(lastHunk?.[1]);
    const span = Number(lastHunk?.[2] ?? 1);
    expect(Math.max(...lines)).toBeLessThan(start + span);
  });
});
