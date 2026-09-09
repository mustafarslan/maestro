import { describe, expect, it } from "vitest";
import { SEVERITIES, severityAtLeast, severityRank } from "./finding.js";

/**
 * Severity ordering was written out six times across the codebase — two zod enums, three
 * rank maps and one array — and `eval.ts` spelled it backwards while everything else
 * spelled it forwards. Both were internally correct, which is what made it dangerous: the
 * same word meant opposite things in different files, and comparing with the wrong sense
 * is a silent inversion that accepts trivia and rejects real defects.
 */
describe("severity ordering", () => {
  it("sorts most serious first", () => {
    expect([...SEVERITIES].sort((a, b) => severityRank(a) - severityRank(b))).toEqual([
      "critical",
      "high",
      "medium",
      "low",
      "info",
    ]);
  });

  it("reads 'at least' in the direction people mean by it", () => {
    // The inversion this exists to prevent: "at least high" must accept critical and
    // reject info, not the reverse.
    expect(severityAtLeast("critical", "high")).toBe(true);
    expect(severityAtLeast("high", "high")).toBe(true);
    expect(severityAtLeast("medium", "high")).toBe(false);
    expect(severityAtLeast("info", "high")).toBe(false);
  });

  it("sorts an unknown severity last rather than first", () => {
    // Treating an unrecognised value as critical would let a malformed finding jump the
    // queue in triage and pass every severity floor.
    expect(severityRank("catastrophic")).toBeGreaterThan(severityRank("info"));
    expect(severityAtLeast("catastrophic", "info")).toBe(false);
  });
});
