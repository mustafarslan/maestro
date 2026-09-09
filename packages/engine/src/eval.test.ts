import { describe, expect, it } from "vitest";
import type { ReviewOutcome } from "./engine.js";
import { compareVersions, type Fixture, scoreOutcome } from "./eval.js";
import type { TriagedFinding } from "./triage.js";

const finding = (over: Partial<TriagedFinding> = {}): TriagedFinding => ({
  file: "pages/api/billing.ts",
  lineStart: 24,
  category: "idor",
  severity: "high",
  confidence: 0.9,
  title: "Endpoint trusts a client-supplied userId",
  body: "No authentication; userId comes straight from the body.",
  agentIds: ["security"],
  agreementCount: 1,
  ...over,
});

const outcome = (posted: TriagedFinding[]): ReviewOutcome => ({
  reviewId: "rv_1",
  state: "done",
  nodes: [
    {
      nodeId: "n1",
      kind: "agent",
      agentId: "security",
      state: "done",
      durationMs: 100,
      costCents: 2,
    },
  ],
  costCents: 2,
  durationMs: 100,
  allowedCommands: [],
  egressLog: [],
  triage: { posted, suppressed: [], summary: "" },
});

const fixture: Fixture = {
  name: "billing-idor",
  target: "./fixture",
  expected: [
    {
      match: "client-supplied userId",
      file: "api/billing.ts",
      line: 24,
      severityAtLeast: "high",
      description: "the IDOR",
    },
  ],
  forbidden: ["consider adding a comment"],
};

describe("scoring", () => {
  it("counts a matching finding as a hit", () => {
    const score = scoreOutcome(fixture, outcome([finding()]));
    expect(score.hits).toHaveLength(1);
    expect(score.misses).toHaveLength(0);
    expect(score.recall).toBe(1);
    expect(score.precision).toBe(1);
  });

  it("counts a missing finding as a recall failure", () => {
    const score = scoreOutcome(fixture, outcome([]));
    expect(score.misses).toEqual(["the IDOR"]);
    expect(score.recall).toBe(0);
  });

  it("does not credit a hit reported in the wrong file", () => {
    const score = scoreOutcome(fixture, outcome([finding({ file: "src/unrelated.ts" })]));
    expect(score.hits).toHaveLength(0);
  });

  it("allows a small line drift, since agents rarely anchor exactly", () => {
    expect(scoreOutcome(fixture, outcome([finding({ lineStart: 30 })])).hits).toHaveLength(1);
    expect(scoreOutcome(fixture, outcome([finding({ lineStart: 300 })])).hits).toHaveLength(0);
  });

  it("does not credit a hit that undersells the severity", () => {
    // Reporting a critical IDOR as "info" is not a success.
    expect(scoreOutcome(fixture, outcome([finding({ severity: "low" })])).hits).toHaveLength(0);
  });

  it("flags a forbidden finding as a false positive", () => {
    const score = scoreOutcome(
      fixture,
      outcome([finding(), finding({ title: "Consider adding a comment here", category: "style" })]),
    );
    expect(score.falsePositives).toHaveLength(1);
    expect(score.precision).toBe(0.5);
  });

  it("counts unexpected findings against precision rather than ignoring them", () => {
    // On a fixture with a known answer key an unverified finding is not a success;
    // treating it as one would let a noisy agent score well.
    const score = scoreOutcome(
      fixture,
      outcome([finding(), finding({ title: "Something else", category: "other" })]),
    );
    expect(score.unclassified).toBe(1);
    expect(score.precision).toBe(0.5);
  });

  it("supports regex matchers", () => {
    const regexFixture: Fixture = {
      ...fixture,
      expected: [{ match: "/client.?supplied\\s+userId/i", file: "api/billing.ts" }],
    };
    expect(scoreOutcome(regexFixture, outcome([finding()])).hits).toHaveLength(1);
  });

  it("does not let one finding satisfy two expectations", () => {
    const twoExpected: Fixture = {
      ...fixture,
      expected: [
        { match: "userId", file: "api/billing.ts" },
        { match: "userId", file: "api/billing.ts" },
      ],
    };
    const score = scoreOutcome(twoExpected, outcome([finding()]));
    expect(score.hits).toHaveLength(1);
    expect(score.misses).toHaveLength(1);
  });
});

describe("version comparison", () => {
  it("aggregates runs per playbook version so pipelines can be compared", () => {
    const scores = [
      { ...scoreOutcome(fixture, outcome([finding()])), playbookVersionId: "pv_new" },
      { ...scoreOutcome(fixture, outcome([])), playbookVersionId: "pv_old" },
    ];
    const compared = compareVersions(scores);

    expect(compared[0]?.playbookVersionId).toBe("pv_new");
    expect(compared[0]?.recall).toBe(1);
    expect(compared[1]?.recall).toBe(0);
  });
});

describe("ratios that cannot be measured", () => {
  const outcome = (titles: string[]) =>
    ({
      triage: {
        posted: titles.map((title) => ({
          title,
          body: "",
          category: "c",
          severity: "high" as const,
          confidence: 0.9,
          agentIds: ["security"],
          agreementCount: 1,
        })),
        suppressed: [],
        summary: "",
      },
      costCents: 0,
      durationMs: 1,
      nodes: [],
    }) as unknown as Parameters<typeof scoreOutcome>[1];

  it("reports no precision when nothing was reported, rather than zero", () => {
    // Zero is a claim; undefined is the truth. Scoring silence as 0% precision makes
    // "said nothing" indistinguishable from "said two wrong things".
    const score = scoreOutcome(
      { name: "f", target: ".", baseRef: "main", expected: [{ match: "idor" }] },
      outcome([]),
    );
    expect(score.precision).toBeUndefined();
    expect(score.recall).toBe(0); // it genuinely missed the one expected finding
  });

  it("reports no recall for a fixture that expects nothing", () => {
    // A clean-code fixture exists to check that Maestro stays QUIET. Scoring it 0%
    // recall made the one fixture that tests for false positives always look like total
    // failure.
    const score = scoreOutcome(
      { name: "clean", target: ".", baseRef: "main", expected: [] },
      outcome([]),
    );
    expect(score.recall).toBeUndefined();
  });

  it("averages only the versions that have a ratio", () => {
    // Folding an absent ratio in as zero drags a version's score down for fixtures that
    // never asked the question.
    const withRatio = scoreOutcome(
      { name: "a", target: ".", baseRef: "main", expected: [{ match: "idor" }] },
      outcome(["idor in the handler"]),
      "pv-1",
    );
    const withoutRatio = scoreOutcome(
      { name: "clean", target: ".", baseRef: "main", expected: [] },
      outcome([]),
      "pv-1",
    );

    const [comparison] = compareVersions([withRatio, withoutRatio]);
    expect(comparison?.recall).toBe(1);
  });
});
