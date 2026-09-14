import { describe, expect, it } from "vitest";
import {
  type Battery,
  batteryProblems,
  bundledBattery,
  loadBattery,
  reviewFirstItems,
  vocabulary,
} from "./battery.js";
import raw from "./battery.json" with { type: "json" };
import { scoreBattery } from "./score.js";

/** A fresh, mutable copy, so one test's damage is not the next test's input. */
const copy = (): Battery => structuredClone(raw) as unknown as Battery;

const item = (b: Battery, id: string) => {
  const found = b.items.find((i) => i.id === id);
  if (!found) throw new Error(`no item ${id}`);
  return found;
};

describe("the bundled battery", () => {
  it("loads with no problems", () => {
    expect(batteryProblems(raw)).toEqual([]);
  });

  it("is version 2.2 with 95 items, every id unique", () => {
    const b = bundledBattery();
    expect(b.version).toBe("2.2");
    expect(b.items).toHaveLength(95);
    expect(new Set(b.items.map((i) => i.id)).size).toBe(95);
  });

  it("carries the fourth format the brief did not list, and loads it", () => {
    const formats = new Set(bundledBattery().items.map((i) => i.format));
    expect(formats).toContain("single_choice_action");
  });

  it("names its vocabularies in its own schema", () => {
    const v = vocabulary(bundledBattery());
    expect(v.core).toContain("blocking_threshold");
    expect(v.core).not.toContain("topic_weights");
    expect(v.topics).toHaveLength(13);
    expect(v.signals).toHaveLength(8);
  });

  it("lists the four items shipped on author judgement, with their notes", () => {
    expect(reviewFirstItems(bundledBattery())).toEqual([
      { id: "DEBT-01", note: "option C contention mitigation" },
      { id: "DEBT-11" },
      { id: "GATE-13" },
      { id: "HAB-09" },
    ]);
  });
});

describe("the 2.2 scoring fixes", () => {
  it("framing preferences carry information: the unchosen framings score 0", () => {
    const b = bundledBattery();
    const ling = b.items.filter((i) => i.id.startsWith("LING-"));
    // The option that is each item's socratic framing, for every item.
    const socratic = Object.fromEntries(
      ling.map((i) => [i.id, i.options.find((o) => o.mapping.socratic_preference === 1)?.label]),
    ) as Record<string, string>;
    const p = scoreBattery(b, socratic);
    expect(p.attributes.socratic_preference).toBe(1);
    expect(p.attributes.directness_preference).toBe(0);
    expect(p.attributes.hedging_preference).toBe(0);

    // Two of fifteen answered directly: the preference is the share, not a constant 1.
    const twoDirect = { ...socratic };
    for (const it of ling.slice(0, 2)) {
      twoDirect[it.id] = it.options.find((o) => o.mapping.directness_preference === 1)
        ?.label as string;
    }
    expect(scoreBattery(b, twoDirect).attributes.directness_preference).toBeCloseTo(2 / 15, 12);
  });

  it("pedantry answers no longer move blocking_threshold", () => {
    const b = bundledBattery();
    const ped = b.items.filter((i) => i.id.startsWith("PED-"));
    for (const it of ped) {
      for (const o of it.options)
        expect(o.mapping, `${it.id}${o.label}`).not.toHaveProperty("blocking_threshold");
    }
    const everyPedAnswered = Object.fromEntries(
      ped.map((i) => [i.id, i.options[0]?.label as string]),
    );
    expect(scoreBattery(b, everyPedAnswered).attributes.blocking_threshold).toBeNull();
  });

  it("every attribute an item informs is mapped on all of its options", () => {
    for (const it of bundledBattery().items) {
      if (it.format === "likert_5") continue;
      const keys = new Set(it.options.flatMap((o) => Object.keys(o.mapping)));
      for (const k of keys) {
        expect(
          it.options.every((o) => k in o.mapping),
          `${it.id} ${k}`,
        ).toBe(true);
      }
    }
  });
});

describe("a battery that is wrong is refused, with every reason", () => {
  it("an attribute mapped on some options of an item but not all", () => {
    const b = copy();
    const opt = item(b, "PED-01").options[0];
    if (opt) opt.mapping.blocking_threshold = 0.2;
    const problems = batteryProblems(b);
    expect(problems).toContain(
      "PED-01: 'blocking_threshold' is mapped on 1 of 4 options, so its mean depends on which option was chosen",
    );
  });

  it("an index that no longer says what the mappings do", () => {
    const b = copy();
    const kai = (b as unknown as { scoring_index: Record<string, string[]> }).scoring_index
      .kai_index;
    kai?.pop();
    expect(batteryProblems(b)).toEqual([
      "scoring_index.kai_index does not list exactly the items that map it",
    ]);
  });

  it("a mapping key the schema does not declare", () => {
    const b = copy();
    for (const o of item(b, "DEBT-01").options) o.mapping.blocking_treshold = 0.4;
    expect(batteryProblems(b)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("mapping key 'blocking_treshold' is not in the schema"),
      ]),
    );
  });

  it("a value outside [0,1]", () => {
    const b = copy();
    const opt = item(b, "PED-01").options[1];
    if (opt) opt.mapping.pedantry_level = 1.2;
    expect(batteryProblems(b)).toEqual([expect.stringContaining("is not in [0,1]")]);
  });

  it("a signal the schema does not declare", () => {
    const b = copy();
    const opt = item(b, "HAB-01").options[0];
    if (opt) opt.extended_signals = { snark: 0.9 };
    expect(batteryProblems(b)).toEqual(
      expect.arrayContaining([expect.stringContaining("signal 'snark'")]),
    );
  });

  it("a duplicate id, and a count that no longer matches", () => {
    const b = copy();
    b.items.push(structuredClone(item(b, "COG-01")));
    const problems = batteryProblems(b);
    expect(problems).toContain("COG-01: duplicate id");
    expect(problems).toContain("question_count is 95 but 96 items exist");
  });

  it("a Likert item whose points are incomplete", () => {
    const b = copy();
    const lm = item(b, "COG-02").likert_mapping;
    if (lm) delete lm.points["3"];
    expect(batteryProblems(b)).toEqual(["COG-02: Likert point 3 is not in [0,1]"]);
  });

  it("loadBattery throws with the list", () => {
    const b = copy();
    for (const o of item(b, "DEBT-01").options) o.mapping.nonsense = 0.5;
    expect(() => loadBattery(b)).toThrow(/nonsense/);
  });

  it("not an object at all", () => {
    expect(batteryProblems(null)).toEqual(["battery is not a JSON object"]);
  });
});

describe("a future version", () => {
  it("adds an attribute to its schema and it is scored with no code change", () => {
    const b = copy();
    b.version = "2.3";
    b.profile_schema.DeveloperCognitiveProfile.nit_appetite = { range: [0, 1] };
    const ped = item(b, "PED-01");
    ped.options.forEach((o, i) => {
      o.mapping.nit_appetite = i / 3;
    });
    (b as unknown as { scoring_index: Record<string, string[]> }).scoring_index.nit_appetite = [
      "PED-01",
    ];
    expect(batteryProblems(b)).toEqual([]);

    const chosen = ped.options[3]?.label as string;
    const profile = scoreBattery(b, { "PED-01": chosen });
    expect(profile.attributes.nit_appetite).toBe(1);
    expect(profile.batteryVersion).toBe("2.3");
  });
});
