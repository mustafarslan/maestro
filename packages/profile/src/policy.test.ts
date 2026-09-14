import type { Finding } from "@maestro/agents";
import type { Severity } from "@maestro/core";
import { describe, expect, it } from "vitest";
import conservative from "./__fixtures__/responses-conservative.json" with { type: "json" };
import promotion from "./__fixtures__/responses-promotion.json" with { type: "json" };
import { bundledBattery } from "./battery.js";
import {
  applyProfile,
  assessFinding,
  COSMETIC_SIGMA,
  DEFAULT_PROFILE_POLICY,
  isArchitectural,
  NON_SUPPRESSIBLE_SIGMA,
  type ProfilePolicy,
  topicFor,
} from "./policy.js";
import { type DeveloperCognitiveProfile, scoreBattery } from "./score.js";

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];

/** Every category slug in the local Maestro database on 2026-09-13, 58 of them. */
const REAL_CATEGORIES = [
  "unhandled-rejection",
  "regression",
  "incorrect-ordering",
  "security-regression",
  "race-condition",
  "prompt-injection",
  "error-handling",
  "lease-expiry",
  "unbounded-growth",
  "resource-lifecycle",
  "off-by-one",
  "utf8-split-corruption",
  "input-validation",
  "backwards-compatibility",
  "type-error",
  "misleading-comment",
  "logic-error",
  "flag-parsing",
  "flag-handling",
  "dead-code",
  "boundary-condition",
  "weak-token-design",
  "weak-session-id-randomness",
  "weak-crypto",
  "unhandled-stream-error",
  "type-mismatch",
  "timing-unsafe-compare",
  "test-destroys-live-state",
  "swallowed-error-reports-ok",
  "stale-files",
  "stale-doc-comment",
  "size-limit-semantics",
  "size-limit-bypass",
  "silent-test-skip",
  "silent-regression",
  "silent-flag-drop",
  "silent-config-drop",
  "session-expiry-unenforced",
  "session-expiry-not-enforced",
  "scope-mismatch",
  "scheduler-fairness",
  "rate-limit",
  "open-proxy",
  "missing-unknown-flag-rejection",
  "missing-tests",
  "missing-test-coverage",
  "interface-contract-gap",
  "insecure-session-id",
  "fairness-regression",
  "fail-open-validation",
  "expired-sessions-never-evicted",
  "data-integrity",
  "command-injection",
  "caching-bug",
  "broken-contract",
  "behavior-change",
  "assignment-instead-of-comparison",
  "accessibility",
];

const finding = (over: Partial<Finding> = {}): Finding => ({
  file: "src/a.ts",
  lineStart: 10,
  lineEnd: 12,
  category: "race-condition",
  severity: "medium",
  confidence: 0.8,
  title: "Two writers race on the counter",
  body: "Both paths read then write without a lock.",
  evidence: "count = count + 1",
  ...over,
});

/** A profile with nothing observed, then the given overrides. */
function profile(
  over: { attributes?: Record<string, number | null>; topicWeights?: Record<string, number> } = {},
): DeveloperCognitiveProfile {
  const p = scoreBattery(bundledBattery(), {});
  return {
    ...p,
    attributes: { ...p.attributes, ...over.attributes },
    topicWeights: { ...p.topicWeights, ...over.topicWeights },
  };
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Profiles from every corner: extremes, unobserved attributes, zero weights. */
function randomProfiles(n: number, seed: number): DeveloperCognitiveProfile[] {
  const next = rng(seed);
  const pick = (): number | null => {
    const r = next();
    return r < 0.1 ? null : r < 0.2 ? 0 : r < 0.3 ? 1 : next();
  };
  const topics = Object.keys(profile().topicWeights);
  return Array.from({ length: n }, () =>
    profile({
      attributes: {
        blocking_threshold: pick(),
        technical_debt_tolerance: pick(),
        pedantry_level: pick(),
      },
      topicWeights: Object.fromEntries(topics.map((t) => [t, pick() ?? 0])),
    }),
  );
}

const CATEGORIES_UNDER_TEST = [...REAL_CATEGORIES, "architectural-shortcut", "naming"];

describe("invariant (a): σ ≥ 0.80 requests changes, whatever the profile", () => {
  it("critical, across 500 profiles and every real category", () => {
    for (const p of randomProfiles(500, 1)) {
      for (const category of CATEGORIES_UNDER_TEST) {
        const a = assessFinding(finding({ severity: "critical", category }), p);
        expect(a.disposition, `${category}`).toBe("request_changes");
        expect(a.effective).toBeGreaterThanOrEqual(a.sigma);
      }
    }
  });

  it("holds exactly at the floor, when a policy puts a level there", () => {
    const policy: ProfilePolicy = {
      ...DEFAULT_PROFILE_POLICY,
      severitySigma: { ...DEFAULT_PROFILE_POLICY.severitySigma, high: NON_SUPPRESSIBLE_SIGMA },
    };
    const lenient = profile({
      attributes: { blocking_threshold: 1, technical_debt_tolerance: 1, pedantry_level: 0 },
      topicWeights: Object.fromEntries(Object.keys(profile().topicWeights).map((t) => [t, 0])),
    });
    for (const category of CATEGORIES_UNDER_TEST) {
      const a = assessFinding(finding({ severity: "high", category }), lenient, policy);
      expect(a.disposition, category).toBe("request_changes");
    }
  });
});

describe("invariant (b): σ < 0.30 never requests changes", () => {
  it("low and info, across 500 profiles and every real category", () => {
    for (const p of randomProfiles(500, 2)) {
      for (const severity of ["low", "info"] as const) {
        for (const category of CATEGORIES_UNDER_TEST) {
          expect(assessFinding(finding({ severity, category }), p).disposition).not.toBe(
            "request_changes",
          );
        }
      }
    }
  });

  it("even a hair under the line, against a developer who blocks on everything", () => {
    const policy: ProfilePolicy = {
      ...DEFAULT_PROFILE_POLICY,
      severitySigma: { ...DEFAULT_PROFILE_POLICY.severitySigma, low: COSMETIC_SIGMA - 1e-9 },
    };
    const strict = profile({
      attributes: { blocking_threshold: 0, pedantry_level: 1, technical_debt_tolerance: 0 },
      topicWeights: Object.fromEntries(Object.keys(profile().topicWeights).map((t) => [t, 1])),
    });
    const a = assessFinding(finding({ severity: "low", category: "style" }), strict, policy);
    expect(a.disposition).toBe("comment");
  });
});

describe("invariant (c): the diagnosis passes through untouched", () => {
  const deepFreeze = <T>(x: T): T => {
    if (x && typeof x === "object") {
      for (const v of Object.values(x)) deepFreeze(v);
      Object.freeze(x);
    }
    return x;
  };

  it("same objects, same fields, same order, for every disposition", () => {
    const inputs = CATEGORIES_UNDER_TEST.flatMap((category) =>
      SEVERITIES.map((severity) => deepFreeze(finding({ category, severity }))),
    );
    const snapshot = structuredClone(inputs);

    for (const p of randomProfiles(50, 3)) {
      const r = applyProfile(inputs, p);
      const out = [...r.kept, ...r.dropped];
      expect(out).toHaveLength(inputs.length);
      // Every finding is the very object triage produced.
      for (const f of out) expect(inputs).toContain(f.finding);
      // Kept findings stay in triage's ranked order.
      const order = r.kept.map((f) => inputs.indexOf(f.finding));
      expect(order).toEqual([...order].sort((x, y) => x - y));
    }
    // Frozen inputs would have thrown on a write; this also checks nothing was replaced.
    expect(inputs).toEqual(snapshot);
  });

  it("the text, file and coordinates a finding carries are the ones it came in with", () => {
    const f = finding({ category: "prompt-injection", severity: "high" });
    const out = assessFinding(f, profile()).finding;
    expect(out).toBe(f);
    expect({
      title: out.title,
      body: out.body,
      file: out.file,
      lineStart: out.lineStart,
      lineEnd: out.lineEnd,
      evidence: out.evidence,
      severity: out.severity,
      category: out.category,
      confidence: out.confidence,
    }).toEqual({
      title: "Two writers race on the counter",
      body: "Both paths read then write without a lock.",
      file: "src/a.ts",
      lineStart: 10,
      lineEnd: 12,
      evidence: "count = count + 1",
      severity: "high",
      category: "prompt-injection",
      confidence: 0.8,
    });
  });
});

describe("topics for the categories agents really emit", () => {
  it.each([
    ["prompt-injection", "security"],
    ["command-injection", "security"],
    ["security-regression", "security"],
    ["weak-crypto", "security"],
    ["timing-unsafe-compare", "security"],
    ["insecure-session-id", "security"],
    ["expired-sessions-never-evicted", "security"],
    ["fail-open-validation", "security"],
    ["open-proxy", "security"],
    ["size-limit-bypass", "security"],
    ["race-condition", "concurrency"],
    ["lease-expiry", "concurrency"],
    ["scheduler-fairness", "concurrency"],
    ["fairness-regression", "concurrency"],
    ["unhandled-rejection", "error_handling"],
    ["swallowed-error-reports-ok", "error_handling"],
    ["error-handling", "error_handling"],
    ["utf8-split-corruption", "data_integrity"],
    ["caching-bug", "data_integrity"],
    ["incorrect-ordering", "data_integrity"],
    ["unbounded-growth", "performance"],
    ["rate-limit", "performance"],
    ["backwards-compatibility", "backward_compatibility"],
    ["behavior-change", "backward_compatibility"],
    ["silent-regression", "backward_compatibility"],
    ["flag-parsing", "api_design"],
    ["missing-unknown-flag-rejection", "api_design"],
    ["broken-contract", "api_design"],
    ["silent-config-drop", "api_design"],
    ["missing-tests", "testing"],
    ["silent-test-skip", "testing"],
    ["misleading-comment", "documentation"],
    ["stale-doc-comment", "documentation"],
    ["stale-files", "data_integrity"],
    ["regression", "backward_compatibility"],
    ["resource-lifecycle", "performance"],
    ["dead-code", "style_formatting"],
    ["SQL_Injection", "security"],
    ["sql query order", "database_transactions"],
  ])("%s → %s", (category, topic) => {
    expect(topicFor(category)).toBe(topic);
  });

  it("a word inside a longer word is not that word", () => {
    expect(topicFor("block-scoping")).toBeNull();
    expect(topicFor("catalog-mismatch")).toBeNull();
    // `error` alone is not error handling: a logic error is a correctness defect.
    expect(topicFor("logic-error")).toBeNull();
    expect(topicFor("type-error")).toBeNull();
  });

  it("plain correctness defects have no topic in this battery, and say so by weight", () => {
    const unmapped = REAL_CATEGORIES.filter((c) => topicFor(c) === null);
    expect(unmapped).toEqual([
      "off-by-one",
      "type-error",
      "logic-error",
      "boundary-condition",
      "type-mismatch",
      "size-limit-semantics",
      "scope-mismatch",
      "assignment-instead-of-comparison",
      "accessibility",
    ]);
  });

  it("architectural shortcuts are recognised by word", () => {
    expect(isArchitectural("architectural-shortcut")).toBe(true);
    expect(isArchitectural("layering-violation")).toBe(true);
    expect(isArchitectural("race-condition")).toBe(false);
  });
});

describe("the profile changes what a finding does", () => {
  const low = scoreBattery(bundledBattery(), conservative);
  const high = scoreBattery(bundledBattery(), promotion);

  it("one high-severity security finding: the defensive developer blocks, the other notes", () => {
    const f = finding({ category: "prompt-injection", severity: "high" });
    expect(assessFinding(f, low).disposition).toBe("request_changes");
    expect(assessFinding(f, high).disposition).toBe("note");
  });

  it("a cosmetic finding: a pedant comments, a pragmatist drops it", () => {
    const f = finding({ category: "naming", severity: "info" });
    expect(assessFinding(f, low).disposition).toBe("comment");
    expect(assessFinding(f, high).disposition).toBe("drop");
  });

  it("the review state follows the findings", () => {
    const findings = [
      finding({ category: "prompt-injection", severity: "high" }),
      finding({ category: "naming", severity: "info" }),
    ];
    expect(applyProfile(findings, low).state).toBe("REQUEST_CHANGES");
    const lenient = applyProfile(findings, high);
    expect(lenient.state).toBe("COMMENT");
    expect(lenient.dropped.map((d) => d.finding.category)).toEqual(["naming"]);
  });

  it("an architectural shortcut that would block becomes a tracked ticket under high debt tolerance", () => {
    const shortcut = finding({ category: "architectural-shortcut", severity: "medium" });
    // 0.5 σ × (1.4 − 0.8 × 0.8) × (0.5 + 0.5 unmapped weight) = 0.38, over a 0.1 threshold: a block.
    const tolerant = profile({
      attributes: { blocking_threshold: 0.1, technical_debt_tolerance: 0.8 },
    });
    const a = assessFinding(shortcut, tolerant);
    expect(a.effective).toBeCloseTo(0.38, 10);
    expect(a.disposition).toBe("comment");
    expect(a.followUp).toBe("tracked_ticket");

    // The same finding and threshold, below the tolerance the rule asks for: it blocks.
    const lessTolerant = profile({
      attributes: { blocking_threshold: 0.1, technical_debt_tolerance: 0.5 },
    });
    const b = assessFinding(shortcut, lessTolerant);
    expect(b.disposition).toBe("request_changes");
    expect(b.followUp).toBeUndefined();
  });

  it("the same shortcut is weighted up for a developer with no tolerance for debt", () => {
    const strict = profile({ attributes: { technical_debt_tolerance: 0 } });
    const a = assessFinding(
      finding({ category: "architectural-shortcut", severity: "medium" }),
      strict,
    );
    // 0.5 σ × (1.4 − 0) × (0.5 + 0.5 unmapped weight)
    expect(a.effective).toBeCloseTo(0.7, 10);
  });
});

describe("a profile with nothing observed leaves every finding where the agents put it", () => {
  /**
   * The battery's guide wrote S = σ × W with an unobserved topic at 0.5, which halved every
   * finding of a developer who had expressed no view: only the non-suppressible floor ever
   * blocked. The scale is now σ × (0.5 + W), the identity at W = 0.5.
   */
  it("S_effective equals σ, for every severity and every real category", () => {
    const neutral = profile();
    for (const category of REAL_CATEGORIES) {
      for (const severity of SEVERITIES) {
        const a = assessFinding(finding({ severity, category }), neutral);
        if (!a.architectural)
          expect(a.effective, `${severity} ${category}`).toBeCloseTo(a.sigma, 12);
      }
    }
  });

  it("so against the fallback threshold a high or medium finding blocks and a low one is a nit", () => {
    const neutral = profile();
    expect(assessFinding(finding({ severity: "high" }), neutral).disposition).toBe(
      "request_changes",
    );
    expect(assessFinding(finding({ severity: "medium" }), neutral).disposition).toBe(
      "request_changes",
    );
    expect(
      assessFinding(finding({ severity: "low", category: "naming" }), neutral).disposition,
    ).toBe("nit");
  });

  it("a topic the developer weighs heavily raises a finding, one they weigh lightly lowers it", () => {
    const heavy = profile({ topicWeights: { concurrency: 1 } });
    const light = profile({ topicWeights: { concurrency: 0 } });
    const f = finding({ severity: "medium", category: "race-condition" });
    expect(assessFinding(f, heavy).effective).toBeCloseTo(0.75, 12);
    expect(assessFinding(f, light).effective).toBeCloseTo(0.25, 12);
  });
});
