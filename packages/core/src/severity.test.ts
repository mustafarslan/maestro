import { describe, expect, it } from "vitest";
import { bySeverity, SEVERITIES, severityAtLeast, severityRank } from "./severity.js";

describe("the one severity ordering", () => {
  it("sorts most serious first", () => {
    const shuffled = ["info", "medium", "critical", "low", "high"].map((severity) => ({
      severity,
    }));
    expect(shuffled.sort(bySeverity).map((s) => s.severity)).toEqual([...SEVERITIES]);
  });

  it("puts medium above info, which alphabetical ordering does not", () => {
    // This is the bug it replaces. `ORDER BY severity` on a TEXT column gives
    // critical, high, info, low, medium — so `medium`, the middle of five levels, sorted
    // last, below `info`. Two places did that: the carried findings that go into the next
    // review's prompt, and the admin API's findings list, which is what the UI shows.
    expect(severityRank("medium")).toBeLessThan(severityRank("info"));
    expect(["info", "medium"].sort()).toEqual(["info", "medium"]); // alphabetical disagrees
  });

  it("sorts an unknown severity last rather than treating it as critical", () => {
    expect(severityRank("catastrophic")).toBe(SEVERITIES.length);
  });

  it("compares floors the way a threshold should", () => {
    expect(severityAtLeast("critical", "medium")).toBe(true);
    expect(severityAtLeast("low", "medium")).toBe(false);
    expect(severityAtLeast("medium", "medium")).toBe(true);
  });
});
