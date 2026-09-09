import type { Finding } from "@maestro/agents";
import { defaultPlaybook } from "@maestro/playbook";
import { describe, expect, it } from "vitest";
import { triage } from "./triage.js";

const doc = defaultPlaybook();

const f = (over: Partial<Finding> = {}): Finding => ({
  file: "src/a.ts",
  lineStart: 10,
  lineEnd: 10,
  category: "sql-injection",
  severity: "high",
  confidence: 0.8,
  title: "Unsanitised input",
  body: "User input reaches the query.",
  ...over,
});

describe("triage", () => {
  it("merges the same defect found by two agents into one comment", () => {
    // Saying it twice is the fastest way to make a review look automated and ignorable.
    const result = triage(doc, [
      { agentId: "security", findings: [f()] },
      { agentId: "architecture", findings: [f({ title: "SQL built by concatenation" })] },
    ]);

    expect(result.posted).toHaveLength(1);
    expect(result.posted[0]?.agentIds.sort()).toEqual(["architecture", "security"]);
    expect(result.posted[0]?.agreementCount).toBe(2);
  });

  it("merges one defect that two agents gave different category slugs", () => {
    // Verbatim from a real Maestro self-review: the same dead ternary was posted twice,
    // as `dead-conditional` and `no-op-ternary`, because the dedupe key included the
    // category and agents invent their own slugs. Two comments for one defect is the
    // failure mode that makes people stop reading an automated reviewer.
    const result = triage(doc, [
      {
        agentId: "architecture",
        findings: [
          f({
            file: "apps/cli/src/commands/reap.ts",
            lineStart: 42,
            category: "dead-conditional",
            title: "Ternary returns the same value on both branches",
            body: "Both branches evaluate to 'ok'.",
          }),
        ],
      },
      {
        agentId: "security",
        findings: [
          f({
            file: "apps/cli/src/commands/reap.ts",
            lineStart: 42,
            category: "no-op-ternary",
            title: "No-op ternary",
            body: "The condition has no effect on the result, so the status is always 'ok' — the failure case is unreachable.",
          }),
        ],
      },
    ]);

    expect(result.posted).toHaveLength(1);
    expect(result.posted[0]?.agreementCount).toBe(2);
    // The fuller explanation survives, with the category that came with it.
    expect(result.posted[0]?.category).toBe("no-op-ternary");
  });

  it("keeps genuinely different defects in the same file apart", () => {
    // Dropping category from the key must not collapse unrelated findings; distance in
    // the file is what separates them.
    const result = triage(doc, [
      {
        agentId: "security",
        findings: [
          f({ lineStart: 10, category: "sql-injection" }),
          f({ lineStart: 200, category: "missing-auth", title: "No auth check" }),
        ],
      },
    ]);
    expect(result.posted.length + result.suppressed.length).toBe(2);
  });

  it("raises confidence when agents agree, because agreement is evidence", () => {
    const alone = triage(doc, [{ agentId: "security", findings: [f({ confidence: 0.7 })] }]);
    const agreed = triage(doc, [
      { agentId: "security", findings: [f({ confidence: 0.7 })] },
      { agentId: "architecture", findings: [f({ confidence: 0.7 })] },
    ]);
    expect(agreed.posted[0]!.confidence).toBeGreaterThan(alone.posted[0]!.confidence);
  });

  it("treats nearby lines in the same file as one defect", () => {
    // Agents rarely anchor to the identical line.
    const result = triage(doc, [
      { agentId: "security", findings: [f({ lineStart: 10 })] },
      { agentId: "architecture", findings: [f({ lineStart: 12 })] },
    ]);
    expect(result.posted).toHaveLength(1);
  });

  it("keeps a second defect at the same location visible instead of discarding it", () => {
    // Grouping by location alone is what stops one defect being posted twice under two
    // invented category slugs. The cost is that two real defects on one line land in the
    // same group — so the merged-away description is carried, not dropped.
    const result = triage(doc, [
      { agentId: "security", findings: [f({ category: "sql-injection" })] },
      {
        agentId: "architecture",
        findings: [
          f({
            category: "null-deref",
            title: "Result may be null",
            body: "The query can return no rows and the caller dereferences the result unconditionally.",
          }),
        ],
      },
    ]);

    expect(result.posted).toHaveLength(1);
    expect(result.posted[0]?.alsoReported).toHaveLength(1);
    const bodies = [result.posted[0]?.body, result.posted[0]?.alsoReported?.[0]?.body].join(" ");
    expect(bodies).toContain("User input reaches the query.");
    expect(bodies).toContain("dereferences the result");
  });

  it("keeps far-apart findings in one file separate", () => {
    const result = triage(doc, [
      {
        agentId: "security",
        findings: [
          f({ lineStart: 10 }),
          f({ lineStart: 400, title: "Unbounded loop", body: "No exit condition." }),
        ],
      },
    ]);
    expect(result.posted).toHaveLength(2);
  });

  it("keeps whole-PR findings apart, because they carry no location to merge on", () => {
    // Reported by Maestro against this very change: dropping category from the key made
    // every line-less finding hash to "repo:none". Unrelated observations merged into
    // one, disagreement was scored as corroboration, and all but the longest body was
    // demoted to a footnote — over-merging, the same failure as duplication wearing the
    // other mask.
    const result = triage(doc, [
      {
        agentId: "product",
        findings: [
          f({
            file: undefined,
            lineStart: undefined,
            lineEnd: undefined,
            category: "missing-acceptance-criteria",
            title: "No acceptance criteria referenced",
            body: "The PR description does not link the Linear issue.",
          }),
          f({
            file: undefined,
            lineStart: undefined,
            lineEnd: undefined,
            category: "missing-tests",
            title: "No tests accompany the change",
            body: "None of the new behaviour is covered by a test.",
          }),
        ],
      },
    ]);

    expect(result.posted.length + result.suppressed.length).toBe(2);
    expect(result.posted.every((p) => p.agreementCount === 1)).toBe(true);
  });

  it("merges across a bucket boundary, which means nothing to a reader", () => {
    // Two agents reporting lines 78 and 80 are reporting one defect; 7 and 8 being
    // different buckets is an artefact of the grouping, not a fact about the code.
    const result = triage(doc, [
      { agentId: "security", findings: [f({ lineStart: 78 })] },
      { agentId: "architecture", findings: [f({ lineStart: 80, title: "Same defect" })] },
    ]);
    expect(result.posted).toHaveLength(1);
    expect(result.posted[0]?.agreementCount).toBe(2);
  });

  it("does not treat one agent reporting twice as agreement with itself", () => {
    const result = triage(doc, [
      {
        agentId: "security",
        findings: [
          f({ lineStart: 78 }),
          f({ lineStart: 80, category: "other", title: "A second defect nearby" }),
        ],
      },
    ]);
    expect(result.posted.every((p) => p.agreementCount === 1)).toBe(true);
  });

  it("suppresses findings below the confidence threshold", () => {
    const result = triage(doc, [{ agentId: "security", findings: [f({ confidence: 0.3 })] }]);
    expect(result.posted).toHaveLength(0);
    expect(result.suppressed[0]?.suppressedReason).toContain("below threshold");
  });

  it("caps the number of posted comments and says how many it held back", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      f({ file: `src/f${i}.ts`, category: `cat-${i}`, confidence: 0.9 }),
    );
    const result = triage(doc, [{ agentId: "security", findings: many }]);

    expect(result.posted).toHaveLength(doc.triage.maxInlineComments);
    expect(result.suppressed.length).toBe(40 - doc.triage.maxInlineComments);
    expect(result.suppressed.every((s) => s.suppressedReason?.includes("cap"))).toBe(true);
  });

  it("ranks by severity first, then by confidence", () => {
    const result = triage(doc, [
      {
        agentId: "security",
        findings: [
          // Distinct locations: findings in the same place are one group by design.
          f({ category: "a", lineStart: 10, severity: "low", confidence: 0.99 }),
          f({ category: "b", lineStart: 100, severity: "critical", confidence: 0.7 }),
          f({ category: "c", lineStart: 200, severity: "high", confidence: 0.95 }),
          f({ category: "d", lineStart: 300, severity: "high", confidence: 0.75 }),
        ],
      },
    ]);
    expect(result.posted.map((x) => x.category)).toEqual(["b", "c", "d", "a"]);
  });

  it("keeps the most severe rating when two agents disagree on severity", () => {
    const result = triage(doc, [
      { agentId: "security", findings: [f({ severity: "critical" })] },
      { agentId: "architecture", findings: [f({ severity: "low" })] },
    ]);
    expect(result.posted[0]?.severity).toBe("critical");
  });

  it("reports a clean review as a real outcome, not a failure", () => {
    const result = triage(doc, [{ agentId: "security", findings: [] }]);
    expect(result.posted).toHaveLength(0);
    expect(result.summary).toContain("No issues met the reporting threshold");
  });
});

describe("cost honesty", () => {
  it("says a provider is unpriced rather than printing 0.00 cents", async () => {
    // A fabricated number in a PR comment is worse than an absent one - this is the
    // same class of bug the pricing provenance table exists to prevent.
    const { renderReview } = await import("./render.js");
    const md = renderReview({
      reviewId: "rv_1",
      state: "done",
      nodes: [
        {
          nodeId: "n1",
          kind: "agent",
          agentId: "security",
          state: "done",
          durationMs: 1000,
          costCents: 0,
        },
      ],
      costCents: 0,
      costKnown: false,
      durationMs: 1000,
      allowedCommands: [],
      egressLog: [],
    });
    expect(md).toContain("cost unpriced for this provider");
    expect(md).not.toContain("0.00¢");
  });

  it("prints a real total when the model is priced", async () => {
    const { renderReview } = await import("./render.js");
    const md = renderReview({
      reviewId: "rv_1",
      state: "done",
      nodes: [],
      costCents: 12.5,
      costKnown: true,
      durationMs: 1000,
      allowedCommands: [],
      egressLog: [],
    });
    expect(md).toContain("12.50¢");
  });
});

describe("environment honesty", () => {
  it("warns the reader when a broken install makes command output unreliable", async () => {
    // The first real run reported typecheck exit 2 that was caused by Maestro's own
    // failed install, not by the code under review.
    const { renderReview } = await import("./render.js");
    const md = renderReview({
      reviewId: "rv_1",
      state: "done",
      nodes: [],
      costCents: 1,
      costKnown: true,
      setupFailed: true,
      durationMs: 1000,
      allowedCommands: ["npm test"],
      egressLog: [],
    });
    expect(md).toContain("dependency installation did not complete");
  });

  it("stays quiet when the environment was fine", async () => {
    const { renderReview } = await import("./render.js");
    const md = renderReview({
      reviewId: "rv_1",
      state: "done",
      nodes: [],
      costCents: 1,
      costKnown: true,
      setupFailed: false,
      durationMs: 1000,
      allowedCommands: [],
      egressLog: [],
    });
    expect(md).not.toContain("dependency installation did not complete");
  });
});
