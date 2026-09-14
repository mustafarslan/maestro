import bundled from "./battery.json" with { type: "json" };

/**
 * The Developer Cognitive Profile Calibration Battery, as a versioned input.
 *
 * Item text, options and values belong to the instrument's owner. Version 2.2 was edited in
 * Maestro at the owner's instruction, to remove selection-biased mappings the 2.1 file had
 * (its `changes_from_v2_1` lists each one); anything further is a new version, never a silent
 * change, because a profile is only meaningful against the instrument that produced it.
 *
 * Every vocabulary — the core attributes, the topic keys, the extended signals — is read
 * from the file's own `profile_schema`, never from a list in this code. A later version that
 * adds an attribute then loads and scores without a code change, and a mapping key that the
 * schema does not declare is refused here rather than scored into an attribute nothing reads.
 *
 * Embedded as a JSON import rather than read from disk: the compiled binary has no
 * directory to read it from, which is the same reason migrations are strings.
 */

export type ReviewState = "APPROVE" | "COMMENT" | "REQUEST_CHANGES";

export interface ReviewAction {
  state: ReviewState;
  comment: string | null;
  follow_up: string;
  requests_tests: boolean;
  includes_suggestion_block: boolean;
}

export interface BatteryOption {
  /** The letter to PRESENT. Options are stored already shuffled. */
  label: string;
  text: string;
  mapping: Record<string, number>;
  extended_signals?: Record<string, number>;
  rationale?: string;
  review_action?: ReviewAction;
  agent_behavior?: string;
  /** The option's original position. For analysis only; scoring never reads it. */
  canonical_rank?: string;
}

export interface LikertMapping {
  attribute: string;
  reverse_scored?: boolean;
  /** Anchor number ("1".."5") to value. A reverse-scored item already carries the inversion. */
  points: Record<string, number>;
}

export interface PrContext {
  title: string;
  description: string;
  files_changed: number;
  additions: number;
  deletions: number;
  ci_status: string;
  author_note?: string;
}

export interface BatteryItem {
  id: string;
  category: string;
  /**
   * `likert_5`, or any of the choice formats. The integration brief lists three formats and
   * this file has four — fifteen items are `single_choice_action` — so anything that is not
   * Likert is scored as a choice, as the reference scorer does, rather than refused.
   */
  format: string;
  stack?: string;
  /** Absent or null on four Likert items, which describe a situation rather than a PR. */
  pr_context?: PrContext | null;
  scenario: string;
  /** Null on six Likert items (COG-03, 07, 08, 09, 11, 12): a statement has no diff. */
  code: string | null;
  prompt: string;
  options: BatteryOption[];
  likert_mapping?: LikertMapping | null;
  behavioral_indicators?: string[];
  presentation?: { shuffled: boolean; seed: number; canonical_order: string[] };
}

export interface AttributeSchema {
  range: [number, number];
  semantics?: string;
  contributing_items?: string[];
}

export interface Battery {
  battery: string;
  version: string;
  question_count: number;
  profile_schema: {
    DeveloperCognitiveProfile: Record<string, AttributeSchema & { keys?: string[] }>;
    ExtendedBehavioralSignals: Record<string, AttributeSchema>;
    aggregation?: Record<string, string>;
  };
  agent_behavior_guide?: {
    purpose?: string;
    tier3?: { attribute: string; rule: string }[];
    tier4?: { attribute: string; rule: string }[];
  };
  quality_assurance?: { items_shipped_on_author_judgement?: string[]; [k: string]: unknown };
  items: BatteryItem[];
}

export const LIKERT_ANCHORS = ["A", "B", "C", "D", "E"] as const;

/** What a mapping or a Likert item may name, all read from the file's own schema. */
export interface BatteryVocabulary {
  /** Scalar profile attributes, e.g. `blocking_threshold`. */
  core: string[];
  /** Topic keys, e.g. `security`; mappings spell them `topic_weights.security`. */
  topics: string[];
  /** Tier 4 style signals, e.g. `comment_density`. */
  signals: string[];
}

const TOPIC_PREFIX = "topic_weights.";

export function vocabulary(b: Pick<Battery, "profile_schema">): BatteryVocabulary {
  const profile = b.profile_schema.DeveloperCognitiveProfile;
  return {
    core: Object.keys(profile).filter((k) => !Array.isArray(profile[k]?.keys)),
    topics: [...(profile.topic_weights?.keys ?? [])],
    signals: Object.keys(b.profile_schema.ExtendedBehavioralSignals),
  };
}

/** `topic_weights.security` → `security`; anything else → undefined. */
export function topicOf(key: string): string | undefined {
  return key.startsWith(TOPIC_PREFIX) ? key.slice(TOPIC_PREFIX.length) : undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const inUnit = (v: unknown): boolean =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/**
 * Every structural problem in a candidate battery, or none.
 *
 * All problems rather than the first: the file is regenerated by someone else, and a report
 * that stops at one error costs them a regeneration per defect.
 */
export function batteryProblems(raw: unknown): string[] {
  const problems: string[] = [];
  if (!isObject(raw)) return ["battery is not a JSON object"];

  const schema = raw.profile_schema;
  if (
    !isObject(schema) ||
    !isObject(schema.DeveloperCognitiveProfile) ||
    !isObject(schema.ExtendedBehavioralSignals)
  ) {
    return ["profile_schema must declare DeveloperCognitiveProfile and ExtendedBehavioralSignals"];
  }
  if (typeof raw.version !== "string" || !raw.version) problems.push("version is missing");
  if (!Array.isArray(raw.items)) return [...problems, "items is not an array"];

  const vocab = vocabulary(raw as unknown as Battery);
  if (!vocab.topics.length) problems.push("profile_schema declares no topic_weights.keys");
  const mappable = new Set([...vocab.core, ...vocab.topics.map((t) => TOPIC_PREFIX + t)]);
  const signals = new Set(vocab.signals);

  if (typeof raw.question_count === "number" && raw.items.length !== raw.question_count) {
    problems.push(`question_count is ${raw.question_count} but ${raw.items.length} items exist`);
  }

  const ids = new Set<string>();
  for (const [index, item] of (raw.items as unknown[]).entries()) {
    if (!isObject(item) || typeof item.id !== "string" || !item.id) {
      problems.push(`item ${index} has no id`);
      continue;
    }
    const id = item.id;
    if (ids.has(id)) problems.push(`${id}: duplicate id`);
    ids.add(id);

    const options = Array.isArray(item.options) ? (item.options as unknown[]) : [];
    const labels = options.map((o) => (isObject(o) ? o.label : undefined));

    if (item.format === "likert_5") {
      const lm = item.likert_mapping;
      if (!isObject(lm) || typeof lm.attribute !== "string" || !isObject(lm.points)) {
        problems.push(`${id}: Likert item without a likert_mapping`);
        continue;
      }
      if (!mappable.has(lm.attribute)) {
        problems.push(`${id}: Likert attribute '${lm.attribute}' is not in the profile schema`);
      }
      for (const n of ["1", "2", "3", "4", "5"]) {
        if (!inUnit(lm.points[n])) problems.push(`${id}: Likert point ${n} is not in [0,1]`);
      }
      if (labels.join("") !== LIKERT_ANCHORS.join("")) {
        problems.push(`${id}: Likert options must be labelled A-E in order`);
      }
      continue;
    }

    if (options.length < 2) problems.push(`${id}: a choice item needs at least two options`);
    if (new Set(labels).size !== labels.length) problems.push(`${id}: duplicate option labels`);
    for (const option of options) {
      if (!isObject(option) || typeof option.label !== "string") {
        problems.push(`${id}: an option has no label`);
        continue;
      }
      const where = `${id}${option.label}`;
      if (!isObject(option.mapping)) {
        problems.push(`${where}: mapping is not an object`);
        continue;
      }
      for (const [key, value] of Object.entries(option.mapping)) {
        if (!mappable.has(key))
          problems.push(`${where}: mapping key '${key}' is not in the schema`);
        if (!inUnit(value)) problems.push(`${where}: mapping '${key}' is not in [0,1]`);
      }
      const ext = option.extended_signals;
      if (ext !== undefined && ext !== null) {
        if (!isObject(ext)) {
          problems.push(`${where}: extended_signals is not an object`);
          continue;
        }
        for (const [key, value] of Object.entries(ext)) {
          if (!signals.has(key)) problems.push(`${where}: signal '${key}' is not in the schema`);
          if (!inUnit(value)) problems.push(`${where}: signal '${key}' is not in [0,1]`);
        }
      }
    }
  }

  // An item informs an attribute on every one of its options or on none. A key carried by
  // only some options makes the mean depend on WHICH option was chosen rather than on the
  // value it carries: in 2.1 the one blocking option of each PED item mapped
  // blocking_threshold, so a pedant's answers pulled it down and nobody's pulled it up.
  const contributors = new Map<string, Set<string>>();
  const signalContributors = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, key: string, itemId: string) => {
    const set = m.get(key) ?? new Set<string>();
    set.add(itemId);
    m.set(key, set);
  };
  for (const item of raw.items as unknown[]) {
    if (!isObject(item) || typeof item.id !== "string") continue;
    if (item.format === "likert_5") {
      const lm = item.likert_mapping;
      if (isObject(lm) && typeof lm.attribute === "string")
        add(contributors, lm.attribute, item.id);
      continue;
    }
    const options = (Array.isArray(item.options) ? (item.options as unknown[]) : []).filter(
      isObject,
    );
    const maps = options.map((o) => (isObject(o.mapping) ? o.mapping : {}));
    for (const key of new Set(maps.flatMap((m) => Object.keys(m)))) {
      const on = maps.filter((m) => key in m).length;
      if (on !== maps.length) {
        problems.push(
          `${item.id}: '${key}' is mapped on ${on} of ${maps.length} options, so its mean depends on which option was chosen`,
        );
      }
      add(contributors, key, item.id);
    }
    for (const o of options) {
      if (isObject(o.extended_signals)) {
        for (const key of Object.keys(o.extended_signals)) add(signalContributors, key, item.id);
      }
    }
  }

  // The indexes are documentation a reader trusts; they must say what the mappings do.
  const listed = (v: unknown) => new Set(Array.isArray(v) ? v.map(String) : []);
  const same = (a: Set<string>, b: Set<string>) =>
    a.size === b.size && [...a].every((x) => b.has(x));
  const drift = (where: string, declared: unknown, actual: Set<string> | undefined) => {
    if (!same(listed(declared), actual ?? new Set())) {
      problems.push(`${where} does not list exactly the items that map it`);
    }
  };
  if (isObject(raw.scoring_index)) {
    for (const [key, ids] of Object.entries(raw.scoring_index)) {
      drift(`scoring_index.${key}`, ids, contributors.get(key));
    }
    for (const key of contributors.keys()) {
      if (!(key in raw.scoring_index)) problems.push(`scoring_index has no entry for '${key}'`);
    }
  }
  if (isObject(raw.extended_signal_index)) {
    for (const [key, ids] of Object.entries(raw.extended_signal_index)) {
      drift(`extended_signal_index.${key}`, ids, signalContributors.get(key));
    }
  }
  for (const key of vocab.core) {
    const entry = (schema.DeveloperCognitiveProfile as Record<string, unknown>)[key];
    if (isObject(entry) && "contributing_items" in entry) {
      drift(
        `profile_schema.${key}.contributing_items`,
        entry.contributing_items,
        contributors.get(key),
      );
    }
  }
  const topicEntry = (schema.DeveloperCognitiveProfile as Record<string, unknown>).topic_weights;
  if (isObject(topicEntry) && "contributing_items" in topicEntry) {
    const union = new Set(
      vocab.topics.flatMap((t) => [...(contributors.get(TOPIC_PREFIX + t) ?? [])]),
    );
    drift("profile_schema.topic_weights.contributing_items", topicEntry.contributing_items, union);
  }
  for (const [key, entry] of Object.entries(schema.ExtendedBehavioralSignals)) {
    if (isObject(entry) && "contributing_items" in entry) {
      drift(
        `profile_schema.${key}.contributing_items`,
        entry.contributing_items,
        signalContributors.get(key),
      );
    }
  }

  const qa = raw.quality_assurance;
  if (isObject(qa) && Array.isArray(qa.items_shipped_on_author_judgement)) {
    for (const entry of qa.items_shipped_on_author_judgement) {
      const itemId = String(entry).split(" ")[0] ?? "";
      if (!ids.has(itemId)) problems.push(`quality_assurance names '${itemId}', which is no item`);
    }
  }
  return problems;
}

/** A checked battery, or an error listing everything wrong with it. */
export function loadBattery(raw: unknown): Battery {
  const problems = batteryProblems(raw);
  if (problems.length) {
    throw new Error(`battery failed validation:\n  ${problems.join("\n  ")}`);
  }
  return raw as Battery;
}

let cached: Battery | undefined;

/** The battery shipped with this build, validated once. */
export function bundledBattery(): Battery {
  cached ??= loadBattery(bundled as unknown);
  return cached;
}

/**
 * Items the battery's own authors shipped on judgement rather than on a clean audit.
 *
 * An admin should read these before trusting a profile that leans on them. The file writes
 * each as an id optionally followed by a note — `DEBT-01 (option C contention mitigation)` —
 * so the note is kept rather than discarded.
 */
export function reviewFirstItems(b: Battery): { id: string; note?: string }[] {
  return (b.quality_assurance?.items_shipped_on_author_judgement ?? []).map((entry) => {
    const [id = "", ...rest] = String(entry).split(" ");
    const note = rest.join(" ").replace(/^\(|\)$/g, "");
    return note ? { id, note } : { id };
  });
}
