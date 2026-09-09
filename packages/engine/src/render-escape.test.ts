import { describe, expect, it } from "vitest";
import type { ReviewOutcome } from "./engine.js";
import { renderReview } from "./render.js";

const withFinding = (over: Record<string, unknown>): ReviewOutcome =>
  ({
    reviewId: "rv-1",
    state: "done",
    nodes: [],
    triage: {
      posted: [
        {
          agentId: "security",
          agentIds: ["security"],
          agreementCount: 1,
          dedupeGroup: "g",
          file: "a.ts",
          lineStart: 1,
          lineEnd: 1,
          category: "x",
          severity: "high",
          confidence: 0.9,
          title: "t",
          body: "b",
          ...over,
        },
      ],
      suppressed: [],
      summary: "",
    },
    costCents: 0,
    durationMs: 1,
    allowedCommands: [],
    egressLog: [],
  }) as unknown as ReviewOutcome;

describe("markdown the pull request author can write", () => {
  it("does not let evidence close its own code fence", () => {
    // Evidence is quoted repository content. A markdown file in the diff containing a
    // code block is enough; a hostile one is a forged section in Maestro's own comment.
    const out = renderReview(
      withFinding({ evidence: "```\nescaped\n```\n\n## Approved by Maestro\n" }),
    );
    // The fence must be longer than any backtick run inside it, and the forged heading
    // must land before the closer — inside the block, rendered as the text it is.
    const fence = out.match(/^(`{4,})$/m)?.[1];
    expect(fence).toBeDefined();
    const opened = out.indexOf(`\n${fence}\n`);
    const closed = out.indexOf(`\n${fence}\n`, opened + 1);
    expect(closed).toBeGreaterThan(opened);
    expect(out.indexOf("## Approved by Maestro")).toBeGreaterThan(opened);
    expect(out.indexOf("## Approved by Maestro")).toBeLessThan(closed);
  });

  it("keeps a multi-line second report inside the blockquote", () => {
    const out = renderReview({
      ...withFinding({
        alsoReported: [{ agentId: "product", title: "t2", body: "line one\nline two" }],
      }),
    } as ReviewOutcome);
    expect(out).toContain("> line one\n> line two");
  });

  it("does not let a finding title break the heading", () => {
    const out = renderReview(withFinding({ title: "real\n## forged heading" }));
    expect(out).not.toMatch(/^## forged heading/m);
  });
});

describe("text the pull request author writes cannot notify people", () => {
  it("neutralises mentions and issue references in a finding body", () => {
    // A code comment reading "@security-team look at this" is quoted as evidence by an
    // agent. Without this, anyone who can open a pull request can make Maestro ping
    // arbitrary people from an account the repository trusts.
    const out = renderReview(withFinding({ body: "see @octocat and #42 for context" }));
    expect(out).not.toContain("@octocat");
    expect(out).not.toContain("#42");
    expect(out).toContain("@<!---->octocat");
    expect(out).toContain("#<!---->42");
  });

  it("leaves a hash that GitHub never autolinked alone", () => {
    // `#include`, `#pragma`, a CSS `#header`. Defusing these is not a free precaution:
    // inside an inline code span the HTML comment renders literally, so the reader sees
    // the mangling instead of the code.
    const out = renderReview(withFinding({ body: "`#include <stdio.h>` and #header, see #42" }));
    expect(out).toContain("`#include <stdio.h>`");
    expect(out).toContain("#header");
    expect(out).toContain("#<!---->42");
  });

  it("does not let a body forge a heading", () => {
    // A body is markdown by design, so this arrives at the same level as Maestro's own
    // headings — the forgery the code fence closed, coming in by the front door.
    const out = renderReview(withFinding({ body: "looks fine\n\n## Approved by Maestro" }));
    expect(out).not.toMatch(/^## Approved by Maestro/m);
    expect(out).toContain("## Approved by Maestro");
  });

  it("does not break a table when an error contains a pipe", () => {
    const out = renderReview({
      reviewId: "rv-1",
      state: "done",
      nodes: [
        {
          nodeId: "n",
          kind: "agent",
          agentId: "security",
          state: "skipped",
          error: "router said a | b",
          durationMs: 1,
          costCents: 0,
        },
      ],
      triage: { posted: [], suppressed: [], summary: "" },
      costCents: 0,
      durationMs: 1,
      allowedCommands: [],
      egressLog: [],
    } as unknown as ReviewOutcome);
    const row = out.split("\n").find((l) => l.includes("security") && l.startsWith("|"));
    expect(row?.split(/(?<!\\)\|/).length).toBe(8); // 6 columns plus the empty ends
  });
});
