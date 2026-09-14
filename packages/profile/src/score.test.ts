import { describe, expect, it } from "vitest";
import pyConservative from "./__fixtures__/python-profile-conservative.json" with { type: "json" };
import pyPromotion from "./__fixtures__/python-profile-promotion.json" with { type: "json" };
import pyRandom from "./__fixtures__/python-profile-random.json" with { type: "json" };
import conservative from "./__fixtures__/responses-conservative.json" with { type: "json" };
import promotion from "./__fixtures__/responses-promotion.json" with { type: "json" };
import random from "./__fixtures__/responses-random.json" with { type: "json" };
import { type Battery, bundledBattery } from "./battery.js";
import { type DeveloperCognitiveProfile, type Responses, round3, scoreBattery } from "./score.js";

/**
 * The port is held to `reference/score_battery.py`'s own outputs.
 *
 * The three `python-profile-*.json` files were produced by running that script, unmodified,
 * over the matching `responses-*.json`:
 *
 *   python3 reference/score_battery.py src/battery.json responses.json
 *
 * `conservative` picks the highest canonical rank on every choice item and the
 * prevention/adaptor end of every Likert statement; `promotion` the opposite; `random`
 * answers about 80% of items at random, so skipped items and partial coverage are covered
 * by the same comparison.
 */

type PythonProfile = Record<string, unknown> & {
  topic_weights: Record<string, number>;
  extended_signals: Record<string, number>;
  coverage: {
    items_answered: number;
    items_skipped: string[];
    n_per_attribute: Record<string, number>;
    n_per_topic: Record<string, number>;
    n_per_extended_signal: Record<string, number>;
  };
};

/**
 * Compared after rounding ours the way the script rounds its own output, so this is exact
 * equality with what the script printed. A tolerance was tried first and failed on exact
 * half-unit ties, which is the one case where "close" and "the same" are different claims.
 */
function expectMatchesReference(ours: DeveloperCognitiveProfile, py: PythonProfile) {
  for (const [k, v] of Object.entries(ours.attributes)) {
    expect(v === null ? null : round3(v), k).toBe(py[k] as number | null);
  }
  for (const [k, v] of Object.entries(ours.topicWeights)) {
    expect(round3(v), k).toBe(py.topic_weights[k]);
  }
  for (const [k, v] of Object.entries(ours.extendedSignals)) {
    expect(round3(v), k).toBe(py.extended_signals[k]);
  }
  expect(ours.framingStrategy).toBe(py.framing_strategy ?? null);
  expect(ours.kaiClassification).toBe(py.kai_classification ?? null);
  expect(ours.regulatoryFocusLabel).toBe(py.regulatory_focus_label ?? null);
  expect(ours.useNegativePolitenessTags).toBe(py.use_negative_politeness_tags_bool);
  expect(ours.coverage.itemsAnswered).toBe(py.coverage.items_answered);
  expect(ours.coverage.itemsSkipped).toEqual(py.coverage.items_skipped);
  expect(ours.coverage.nPerAttribute).toEqual(py.coverage.n_per_attribute);
  expect(ours.coverage.nPerTopic).toEqual(py.coverage.n_per_topic);
  expect(ours.coverage.nPerExtendedSignal).toEqual(py.coverage.n_per_extended_signal);
}

describe("agreement with the reference scorer", () => {
  const cases: [string, Responses, unknown][] = [
    ["conservative", conservative, pyConservative],
    ["promotion", promotion, pyPromotion],
    ["random, partial", random, pyRandom],
  ];
  for (const [name, responses, py] of cases) {
    it(name, () => {
      expectMatchesReference(scoreBattery(bundledBattery(), responses), py as PythonProfile);
    });
  }

  it("the partial sheet really is partial", () => {
    const p = scoreBattery(bundledBattery(), random);
    expect(p.coverage.itemsSkipped.length).toBeGreaterThan(0);
    expect(p.coverage.itemsAnswered + p.coverage.itemsSkipped.length).toBe(95);
  });
});

describe("two opposite respondents produce clearly separated profiles", () => {
  const low = scoreBattery(bundledBattery(), conservative);
  const high = scoreBattery(bundledBattery(), promotion);
  const a = (p: DeveloperCognitiveProfile, k: string) => p.attributes[k] as number;

  it("blocking_threshold: blocks early against blocks late", () => {
    expect(a(low, "blocking_threshold")).toBeLessThan(0.2);
    expect(a(high, "blocking_threshold")).toBeGreaterThan(0.8);
  });

  it("technical_debt_tolerance, kai_index and regulatory_focus", () => {
    for (const k of ["technical_debt_tolerance", "kai_index", "regulatory_focus"]) {
      expect(a(low, k), k).toBeLessThan(0.15);
      expect(a(high, k), k).toBeGreaterThan(0.85);
    }
    expect(low.kaiClassification).toBe("Adaptor");
    expect(high.kaiClassification).toBe("Innovator");
    expect(low.regulatoryFocusLabel).toBe("Prevention");
    expect(high.regulatoryFocusLabel).toBe("Promotion");
  });

  it("pedantry runs the other way", () => {
    expect(a(low, "pedantry_level")).toBeGreaterThan(0.8);
    expect(a(high, "pedantry_level")).toBeLessThan(0.1);
  });
});

/** Deterministic, so a failure reproduces. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("shuffle invariance", () => {
  /**
   * Relabels every choice item's options and re-sorts them into the new label order — what a
   * different presentation shuffle would have stored — and moves each answer to follow the
   * option it named. Likert anchors are not shuffled: their letter IS the anchor.
   */
  function reshuffle(battery: Battery, responses: Responses, seed: number) {
    const next = rng(seed);
    const b = structuredClone(battery);
    const moved: Responses = {};
    for (const item of b.items) {
      const answer = responses[item.id];
      if (item.format === "likert_5") {
        if (answer !== undefined) moved[item.id] = answer;
        continue;
      }
      const labels = item.options.map((o) => o.label);
      for (let i = labels.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [labels[i], labels[j]] = [labels[j] as string, labels[i] as string];
      }
      item.options.forEach((o, i) => {
        if (answer === o.label) moved[item.id] = labels[i] as string;
        o.label = labels[i] as string;
      });
      item.options.sort((x, y) => x.label.localeCompare(y.label));
    }
    return { battery: b, responses: moved };
  }

  for (const [name, responses] of [
    ["conservative", conservative],
    ["promotion", promotion],
    ["random", random],
  ] as const) {
    it(`${name}: every score survives five reshuffles unchanged`, () => {
      const original = scoreBattery(bundledBattery(), responses);
      for (let seed = 1; seed <= 5; seed++) {
        const r = reshuffle(bundledBattery(), responses, seed);
        const sheet: Responses = responses;
        const labelsMoved = Object.keys(sheet).some((id) => r.responses[id] !== sheet[id]);
        expect(labelsMoved, "the reshuffle changed nothing, so it tested nothing").toBe(true);
        expect(scoreBattery(r.battery, r.responses)).toEqual(original);
      }
    });
  }
});

describe("a sheet saved half-way, or written by hand", () => {
  it("an empty sheet scores, with every core attribute unobserved and every default 0.5", () => {
    const p = scoreBattery(bundledBattery(), {});
    expect(Object.values(p.attributes).every((v) => v === null)).toBe(true);
    expect(Object.values(p.topicWeights).every((v) => v === 0.5)).toBe(true);
    expect(Object.values(p.extendedSignals).every((v) => v === 0.5)).toBe(true);
    expect(p.framingStrategy).toBeNull();
    expect(p.useNegativePolitenessTags).toBe(false);
    expect(p.coverage.itemsSkipped).toHaveLength(95);
  });

  it("a label the item does not offer is reported, not thrown", () => {
    const p = scoreBattery(bundledBattery(), { "LING-01": "D", "COG-01": "F", "DEBT-01": "B" });
    expect(p.coverage.invalid).toEqual([
      { itemId: "COG-01", label: "F" },
      { itemId: "LING-01", label: "D" },
    ]);
    expect(p.coverage.itemsAnswered).toBe(1);
  });

  it("an answer to no item is reported", () => {
    const p = scoreBattery(bundledBattery(), { "DEBT-99": "A" });
    expect(p.coverage.unknownItems).toEqual(["DEBT-99"]);
  });

  it("a Likert answer takes its value from the points map, reverse scoring included", () => {
    // COG-01 is reverse-scored: "5 - Strongly Agree" with an adaptor statement is kai 0.
    const p = scoreBattery(bundledBattery(), { "COG-01": "E" });
    expect(p.attributes.kai_index).toBe(0);
  });
});

describe("round3 is Python's round(x, 3)", () => {
  it("rounds ties to even", () => {
    expect(round3(0.0625)).toBe(0.062);
    expect(round3(0.1875)).toBe(0.188);
    expect(round3(0.3294)).toBe(0.329);
    expect(round3(0.3296)).toBe(0.33);
  });

  it("a phi a hair under the boundary is classified as the script classifies it", () => {
    const b = structuredClone(bundledBattery());
    // Force phi_framing to 0.3296 through one option: rounded, it is 0.33 — Balanced.
    const opt = b.items.find((i) => i.id === "LING-01")?.options.find((o) => o.label === "A");
    if (opt) opt.mapping.phi_framing = 0.3296;
    expect(scoreBattery(b, { "LING-01": "A" }).framingStrategy).toBe("Balanced_Inquisitive");
  });
});
