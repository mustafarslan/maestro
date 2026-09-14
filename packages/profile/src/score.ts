import { type Battery, LIKERT_ANCHORS, vocabulary } from "./battery.js";

/**
 * Scoring: a response sheet in, a DeveloperCognitiveProfile out.
 *
 * A port of `reference/score_battery.py`, whose BEHAVIOUR is the contract. The tests hold
 * this module to that script's own outputs on three committed response sheets, so a
 * divergence shows up as a failing number rather than as an argument about intent.
 *
 * Where it deliberately differs from the script, each difference is one the script would
 * crash on or cannot express:
 *
 *  - Values are kept unrounded. The script rounds to three places with Python's
 *    round-half-even, which JavaScript has no builtin for; rounding at store time would make
 *    a rounding mismatch look like a scoring bug. The derived LABELS are computed on the
 *    three-place value, because that is what the script compares against its thresholds.
 *  - A label the item does not offer is reported in `coverage.invalid`. The script raises
 *    `StopIteration`, which for a questionnaire saved half-way is the wrong failure.
 *  - Answers naming no item are reported in `coverage.unknownItems`; the script ignores them.
 *  - The attribute lists come from the battery's schema; the script hardcodes them.
 */

/** `{ "<item id>": "<presented label>" }` */
export type Responses = Record<string, string>;

export type FramingStrategy = "Direct_Imperative" | "Balanced_Inquisitive" | "Strictly_Socratic";
export type KaiClassification = "Adaptor" | "Bridger" | "Innovator";
export type RegulatoryFocusLabel = "Prevention" | "Mixed" | "Promotion";

export interface ProfileCoverage {
  itemsAnswered: number;
  itemsSkipped: string[];
  invalid: { itemId: string; label: string }[];
  unknownItems: string[];
  nPerAttribute: Record<string, number>;
  nPerTopic: Record<string, number>;
  nPerExtendedSignal: Record<string, number>;
}

export interface DeveloperCognitiveProfile {
  batteryVersion: string;
  /**
   * Core scalars, `null` when nothing the developer answered informs them. Not 0.5: the
   * reference scorer distinguishes "unobserved" for these, and a consumer that needs a
   * number supplies its own default where the rule it implements says what that should be.
   */
  attributes: Record<string, number | null>;
  /** Defaults to 0.5 for a topic no answer touched, per the battery's aggregation rules. */
  topicWeights: Record<string, number>;
  /** Tier 4 only. Also defaults to 0.5. */
  extendedSignals: Record<string, number>;
  framingStrategy: FramingStrategy | null;
  /** `use_negative_politeness_tags` binarised at 0.5. False when unobserved. */
  useNegativePolitenessTags: boolean;
  kaiClassification: KaiClassification | null;
  regulatoryFocusLabel: RegulatoryFocusLabel | null;
  coverage: ProfileCoverage;
}

const UNOBSERVED = 0.5;

/**
 * A finite double as an exact binary fraction: `x === num * 2 ** exp`.
 *
 * The two functions below need the value a double really holds, not the decimal it prints
 * as, because that is what Python's arithmetic is exact over.
 */
function exactBits(x: number): { num: bigint; exp: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const biased = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (biased !== 0) mantissa |= 1n << 52n;
  const num = hi >>> 31 ? -mantissa : mantissa;
  return { num, exp: biased === 0 ? -1074 : biased - 1075 };
}

const bitLength = (n: bigint): number => (n === 0n ? 0 : n.toString(2).length);

/**
 * The arithmetic mean, exactly as Python's `statistics.mean` computes it.
 *
 * That function sums floats as exact fractions and converts the quotient to the nearest
 * double once. A running floating-point sum drifts by a unit in the last place, and this
 * battery's means land on exact half-thousandths often enough for that drift to flip the
 * three-place value the reference prints — measured: 0.918 against the script's 0.917 on
 * `topic_weights.api_design`. So the sum is done in BigInt, and the one division is
 * rounded to nearest the way IEEE division is.
 */
export function exactMean(xs: readonly number[]): number {
  if (!xs.length) throw new Error("mean of nothing");
  // Zeros add nothing, and a zero's bits report the smallest exponent a double has, which
  // would scale everything else past what a double can hold. Measured as NaN on every
  // attribute a Likert point of exactly 0 contributed to.
  const parts = xs.map(exactBits).filter((p) => p.num !== 0n);
  if (!parts.length) return 0;
  const minExp = Math.min(...parts.map((p) => p.exp));
  let sum = 0n;
  for (const p of parts) sum += p.num << BigInt(p.exp - minExp);
  if (sum === 0n) return 0;

  // mean = sum * 2^minExp / n. Take the quotient to at least 64 bits and fold whether a
  // remainder was left into one sticky bit, so Number()'s round-to-nearest-even sees
  // everything that decides it.
  const negative = sum < 0n;
  const p = negative ? -sum : sum;
  const q = BigInt(xs.length);
  const shift = Math.max(0, 64 + bitLength(q) - bitLength(p));
  const scaled = p << BigInt(shift);
  const sticky = scaled % q === 0n ? 0n : 1n;
  const quotient = ((scaled / q) << 1n) | sticky;
  const magnitude = Number(quotient) * 2 ** (minExp - shift - 1);
  return negative ? -magnitude : magnitude;
}

/**
 * Python's `round(x, 3)`: half-to-even, decided on the exact value the double holds.
 *
 * Only ever used where the reference compares or prints a rounded value.
 */
export function round3(x: number): number {
  const { num, exp } = exactBits(x);
  if (exp >= 0 || num === 0n) return x;
  const k = BigInt(-exp);
  const negative = num < 0n;
  const scaled = (negative ? -num : num) * 1000n;
  let whole = scaled >> k;
  const twiceRemainder = (scaled - (whole << k)) << 1n;
  const denominator = 1n << k;
  if (twiceRemainder > denominator || (twiceRemainder === denominator && whole & 1n)) whole += 1n;
  const rounded = Number(whole) / 1000;
  return negative ? -rounded : rounded;
}

const mean = exactMean;

export function scoreBattery(battery: Battery, responses: Responses): DeveloperCognitiveProfile {
  const vocab = vocabulary(battery);
  const values = new Map<string, number[]>();
  const signals = new Map<string, number[]>();
  const push = (m: Map<string, number[]>, k: string, v: number) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };

  const coverage: ProfileCoverage = {
    itemsAnswered: 0,
    itemsSkipped: [],
    invalid: [],
    unknownItems: [],
    nPerAttribute: {},
    nPerTopic: {},
    nPerExtendedSignal: {},
  };

  const itemIds = new Set(battery.items.map((i) => i.id));
  coverage.unknownItems = Object.keys(responses).filter((id) => !itemIds.has(id));

  for (const item of battery.items) {
    const label = responses[item.id];
    if (label === undefined || label === null) {
      coverage.itemsSkipped.push(item.id);
      continue;
    }

    if (item.format === "likert_5") {
      const anchor = (LIKERT_ANCHORS as readonly string[]).indexOf(label);
      const lm = item.likert_mapping;
      const point = anchor >= 0 && lm ? lm.points[String(anchor + 1)] : undefined;
      if (!lm || point === undefined) {
        coverage.invalid.push({ itemId: item.id, label });
        continue;
      }
      coverage.itemsAnswered += 1;
      push(values, lm.attribute, point);
      continue;
    }

    const option = item.options.find((o) => o.label === label);
    if (!option) {
      coverage.invalid.push({ itemId: item.id, label });
      continue;
    }
    coverage.itemsAnswered += 1;
    for (const [k, v] of Object.entries(option.mapping)) push(values, k, v);
    for (const [k, v] of Object.entries(option.extended_signals ?? {})) push(signals, k, v);
  }

  const attributes: Record<string, number | null> = {};
  for (const k of vocab.core) {
    const xs = values.get(k) ?? [];
    attributes[k] = xs.length ? mean(xs) : null;
    coverage.nPerAttribute[k] = xs.length;
  }
  const topicWeights: Record<string, number> = {};
  for (const t of vocab.topics) {
    const xs = values.get(`topic_weights.${t}`) ?? [];
    topicWeights[t] = xs.length ? mean(xs) : UNOBSERVED;
    coverage.nPerTopic[t] = xs.length;
  }
  const extendedSignals: Record<string, number> = {};
  for (const s of vocab.signals) {
    const xs = signals.get(s) ?? [];
    extendedSignals[s] = xs.length ? mean(xs) : UNOBSERVED;
    coverage.nPerExtendedSignal[s] = xs.length;
  }

  const at = (k: string): number | null => {
    const v = attributes[k];
    return v === undefined || v === null ? null : round3(v);
  };
  const phi = at("phi_framing");
  const tags = at("use_negative_politeness_tags");
  const kai = at("kai_index");
  const rf = at("regulatory_focus");

  return {
    batteryVersion: battery.version,
    attributes,
    topicWeights,
    extendedSignals,
    framingStrategy:
      phi === null
        ? null
        : phi < 0.33
          ? "Direct_Imperative"
          : phi <= 0.66
            ? "Balanced_Inquisitive"
            : "Strictly_Socratic",
    useNegativePolitenessTags: tags !== null && tags >= 0.5,
    kaiClassification:
      kai === null ? null : kai < 0.4 ? "Adaptor" : kai <= 0.6 ? "Bridger" : "Innovator",
    regulatoryFocusLabel:
      rf === null ? null : rf < 0.4 ? "Prevention" : rf <= 0.6 ? "Mixed" : "Promotion",
    coverage,
  };
}
