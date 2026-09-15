import type { Severity } from "@maestro/core";
import type { ProfilePolicyOverride } from "@maestro/playbook";
import type { DeveloperCognitiveProfile } from "./score.js";

/**
 * Tier 3: what a developer's profile does to a finding that has already been diagnosed.
 *
 * The integration brief describes a pipeline Maestro is not built as, so this is the mapping,
 * written once where it is used:
 *
 *  - **Tier 2** is the specialist agents. Their prompts carry no profile: a diagnosis that
 *    changed with the reader would stop being a diagnosis.
 *  - **σ** is the finding's severity, through a configurable table. Maestro's agents emit a
 *    five-level enum, not a number, and `confidence` is a different quantity — how sure the
 *    agent is, which triage already gates on — so it is deliberately not folded in.
 *  - **W_topic** needs a topic, and agents invent their own category slugs: the local
 *    database holds 58 distinct ones over 153 findings. `topicFor` maps them with keyword
 *    rules matched on whole hyphen-separated words, so `logic-error` does not read as error
 *    handling and `catalog` would not read as logging.
 *  - **Tier 3 itself** runs after deterministic triage and only ANNOTATES: each finding is
 *    carried by reference, never copied or rewritten, and gains a disposition beside it.
 *
 * Two numbers are invariants rather than thresholds and are not configurable, because a
 * configuration that could move them could break them: σ ≥ 0.80 always requests changes, and
 * σ < 0.30 never does.
 *
 * Everything else follows `agent_behavior_guide.tier3` and is a default, not a calibration.
 */

/** At or above this σ a finding requests changes whatever the profile says. */
export const NON_SUPPRESSIBLE_SIGMA = 0.8;
/** Below this σ a finding is cosmetic and can never request changes. */
export const COSMETIC_SIGMA = 0.3;

export type Disposition =
  /** Blocks: the review would be REQUEST_CHANGES. */
  | "request_changes"
  /** Raised and worth an answer, but does not block. */
  | "comment"
  /** Raised with a face-saving tag; the author may skip it. */
  | "nit"
  /** Kept as an advisory note under an otherwise approving review. */
  | "note"
  /** Not posted. Only a cosmetic finding can land here. */
  | "drop";

export interface TopicRule {
  topic: string;
  /** Whole words or hyphenated phrases, matched on word boundaries within the category. */
  keywords: string[];
}

export interface ProfilePolicy {
  severitySigma: Record<Severity, number>;
  /**
   * How a topic weight scales σ: S = σ × (base + slope × W).
   *
   * The battery's guide writes S = σ × W, which with W at 0.5 for an unobserved topic halved
   * every finding of a developer who expressed no view — so a fresh profile blocked on
   * nothing below the non-suppressible floor. The default here is the identity at W = 0.5,
   * monotone in W, and bounded to [0.5σ, 1.5σ] before clamping: "no opinion" leaves a finding
   * where the agents put it.
   */
  topicScale: { base: number; slope: number };
  /** COMMENT when S_effective is within this much below the blocking threshold. */
  commentBand: number;
  pedantry: {
    /** Below this, cosmetic findings are dropped. */
    dropBelow: number;
    /** At or above this, cosmetic findings may reach COMMENT; between the two they are nits. */
    commentAtOrAbove: number;
  };
  debt: {
    /** σ × (base − slope × technical_debt_tolerance), for architectural findings. */
    base: number;
    slope: number;
    /** A tolerant developer's sub-threshold architectural blocks become tracked tickets. */
    trackedTicketMinTolerance: number;
    trackedTicketBelowSigma: number;
  };
  /** Category words that mark an architectural shortcut. The battery names the tag; no agent emits it. */
  architecturalKeywords: string[];
  /** Ordered: the first rule with a matching keyword decides. */
  topicRules: TopicRule[];
  /**
   * W for a finding no rule could place.
   *
   * 0.5, the same value the battery gives a topic the developer was never asked about — a
   * finding of unknown topic is treated like one they expressed no view on. Since battery 2.3
   * plain defects have their own topic, `correctness`, and few real findings land here.
   */
  unmappedTopicWeight: number;
  /** Used where the profile has no estimate for an attribute a rule reads. */
  fallbacks: {
    blocking_threshold: number;
    technical_debt_tolerance: number;
    pedantry_level: number;
  };
}

export const DEFAULT_PROFILE_POLICY: ProfilePolicy = {
  // Only `critical` sits above the non-suppressible floor by default, so every other level
  // is left to the profile; `low` and `info` sit below the cosmetic line and never block.
  severitySigma: { critical: 0.95, high: 0.75, medium: 0.5, low: 0.25, info: 0.1 },
  topicScale: { base: 0.5, slope: 1 },
  commentBand: 0.15,
  pedantry: { dropBelow: 0.3, commentAtOrAbove: 0.7 },
  debt: { base: 1.4, slope: 0.8, trackedTicketMinTolerance: 0.6, trackedTicketBelowSigma: 0.6 },
  architecturalKeywords: [
    "architecture",
    "architectural",
    "layering",
    "coupling",
    "abstraction",
    "tech-debt",
    "technical-debt",
    "shortcut",
    "code-duplication",
    "duplication",
    "separation-of-concerns",
    "modularity",
    "convention",
    "pattern",
  ],
  // Ordered from the most to the least specific claim about what went wrong: an injection
  // through SQL is a security finding first, a regression in fairness a concurrency one.
  topicRules: [
    {
      topic: "security",
      keywords: [
        "security",
        "injection",
        "prompt-injection",
        "crypto",
        "token",
        "session",
        "sessions",
        "auth",
        "authn",
        "authz",
        "authentication",
        "authorization",
        "csrf",
        "xss",
        "ssrf",
        "idor",
        "secret",
        "secrets",
        "credential",
        "credentials",
        "permission",
        "permissions",
        "proxy",
        "timing-unsafe",
        "traversal",
        "bypass",
        "fail-open",
        "input-validation",
        "vulnerability",
        "sandbox-escape",
      ],
    },
    {
      topic: "database_transactions",
      keywords: ["sql", "transaction", "transactions", "database", "db", "migration", "query"],
    },
    {
      topic: "concurrency",
      keywords: [
        "race",
        "race-condition",
        "concurrency",
        "concurrent",
        "deadlock",
        "lock",
        "locking",
        "lease",
        "mutex",
        "atomic",
        "atomicity",
        "thread",
        "fairness",
        "scheduler",
        "reentrancy",
      ],
    },
    {
      topic: "error_handling",
      keywords: [
        "error-handling",
        "unhandled",
        "unhandled-rejection",
        "swallowed",
        "exception",
        "exceptions",
        "panic",
        "retry",
        "retries",
      ],
    },
    // Ahead of data integrity, so a stale DOC comment is a documentation finding rather than
    // a stale-data one. Not the bare word `comment`: in this codebase that is usually a
    // GitHub comment, and `comment-marker-author` is an authorization defect, not a doc one.
    {
      topic: "documentation",
      keywords: [
        "doc",
        "docs",
        "documentation",
        "docstring",
        "jsdoc",
        "readme",
        "misleading-comment",
      ],
    },
    {
      topic: "data_integrity",
      keywords: [
        "data-integrity",
        "integrity",
        "corruption",
        "corrupt",
        "utf8",
        "encoding",
        "truncation",
        "overflow",
        "precision",
        "double-count",
        "lost-update",
        "stale",
        "caching",
        "cache",
        "idempotency",
        "ordering",
      ],
    },
    {
      topic: "performance",
      keywords: [
        "performance",
        "perf",
        "slow",
        "latency",
        "unbounded",
        "memory",
        "leak",
        "n-plus-one",
        "allocation",
        "complexity",
        "rate-limit",
        "throughput",
        "resource-lifecycle",
      ],
    },
    {
      topic: "backward_compatibility",
      keywords: [
        "backwards-compatibility",
        "backward-compatibility",
        "compatibility",
        "breaking",
        "behavior-change",
        "deprecation",
        "regression",
      ],
    },
    {
      topic: "dependency_management",
      keywords: ["dependency", "dependencies", "lockfile", "supply-chain", "version-pin"],
    },
    {
      topic: "api_design",
      keywords: ["api", "contract", "interface", "signature", "flag", "config", "cli", "schema"],
    },
    // After every named domain, so a race or an injection keeps its own topic; before
    // observability, testing and style, which a plain bug is not. Phrases, not bare `type` or
    // `error`, which occur inside names that are not defects at all.
    {
      topic: "correctness",
      keywords: [
        "correctness",
        "off-by-one",
        "boundary-condition",
        "edge-case",
        "logic-error",
        "type-error",
        "type-mismatch",
        "type-coercion",
        "wrong-operator",
        "inverted-condition",
        "assignment-instead-of-comparison",
        "null-dereference",
        "nan",
        "semantics",
      ],
    },
    {
      topic: "observability",
      keywords: ["logging", "log", "logs", "metrics", "tracing", "telemetry", "observability"],
    },
    { topic: "testing", keywords: ["test", "tests", "testing", "coverage", "flaky"] },
    {
      topic: "style_formatting",
      keywords: [
        "style",
        "formatting",
        "naming",
        "lint",
        "typo",
        "whitespace",
        "readability",
        "dead-code",
        "unused",
        "cosmetic",
      ],
    },
  ],
  unmappedTopicWeight: 0.5,
  fallbacks: { blocking_threshold: 0.5, technical_debt_tolerance: 0.5, pedantry_level: 0.5 },
};

/**
 * The policy a playbook asks for: its `triage.profilePolicy` merged over the defaults, one level
 * deep, arrays replacing. Refuses a merge that leaves the pedantry bands inverted, which the
 * schema cannot see because either half may come from the defaults.
 */
export function resolvePolicy(override?: ProfilePolicyOverride): ProfilePolicy {
  if (!override) return DEFAULT_PROFILE_POLICY;
  const d = DEFAULT_PROFILE_POLICY;
  const policy: ProfilePolicy = {
    severitySigma: { ...d.severitySigma, ...defined(override.severitySigma) },
    topicScale: { ...d.topicScale, ...defined(override.topicScale) },
    commentBand: override.commentBand ?? d.commentBand,
    pedantry: { ...d.pedantry, ...defined(override.pedantry) },
    debt: { ...d.debt, ...defined(override.debt) },
    architecturalKeywords: override.architecturalKeywords ?? d.architecturalKeywords,
    topicRules: override.topicRules ?? d.topicRules,
    unmappedTopicWeight: override.unmappedTopicWeight ?? d.unmappedTopicWeight,
    fallbacks: { ...d.fallbacks, ...defined(override.fallbacks) },
  };
  if (policy.pedantry.dropBelow > policy.pedantry.commentAtOrAbove) {
    throw new Error(
      `triage.profilePolicy: pedantry.dropBelow (${policy.pedantry.dropBelow}) is above commentAtOrAbove (${policy.pedantry.commentAtOrAbove})`,
    );
  }
  return policy;
}

function defined<T extends object>(o: T | undefined): Partial<T> {
  return Object.fromEntries(
    Object.entries(o ?? {}).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/** `keyword` appears in `category` as whole words: `lock` matches `lock-order`, not `block`. */
function hasWord(category: string, keyword: string): boolean {
  return `-${category}-`.includes(`-${keyword.toLowerCase()}-`);
}

/** Slugs arrive as `SQL_Injection`, `sql injection` or `sql-injection`; all three are one. */
function normalise(category: string): string {
  return category
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function topicFor(
  category: string,
  rules: readonly TopicRule[] = DEFAULT_PROFILE_POLICY.topicRules,
): string | null {
  const slug = normalise(category);
  return rules.find((r) => r.keywords.some((k) => hasWord(slug, k)))?.topic ?? null;
}

export function isArchitectural(
  category: string,
  keywords: readonly string[] = DEFAULT_PROFILE_POLICY.architecturalKeywords,
): boolean {
  const slug = normalise(category);
  return keywords.some((k) => hasWord(slug, k));
}

/** The fields of a finding this tier reads. Nothing else of it is touched. */
export interface GateableFinding {
  category: string;
  severity: Severity;
}

export interface ProfiledFinding<T extends GateableFinding> {
  /** The finding exactly as triage produced it — the same object, not a copy. */
  finding: T;
  sigma: number;
  topic: string | null;
  topicWeight: number;
  architectural: boolean;
  /** S_effective. Never below σ for a non-suppressible finding. */
  effective: number;
  disposition: Disposition;
  followUp?: "tracked_ticket";
  /** Why, in the terms of the rule that decided. */
  reason: string;
}

export interface ProfiledReview<T extends GateableFinding> {
  /** Everything not dropped, in the order triage ranked it. */
  kept: ProfiledFinding<T>[];
  dropped: ProfiledFinding<T>[];
  /** The review state this developer would submit. Maestro never APPROVEs on its own. */
  state: "REQUEST_CHANGES" | "COMMENT";
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const fmt = (x: number) => x.toFixed(2);

export function assessFinding<T extends GateableFinding>(
  finding: T,
  profile: DeveloperCognitiveProfile,
  policy: ProfilePolicy = DEFAULT_PROFILE_POLICY,
): ProfiledFinding<T> {
  const attr = (k: keyof ProfilePolicy["fallbacks"]): number =>
    profile.attributes[k] ?? policy.fallbacks[k];

  const sigma = policy.severitySigma[finding.severity];
  const topic = topicFor(finding.category, policy.topicRules);
  const topicWeight =
    topic === null
      ? policy.unmappedTopicWeight
      : (profile.topicWeights[topic] ?? policy.unmappedTopicWeight);
  const architectural = isArchitectural(finding.category, policy.architecturalKeywords);
  const tolerance = attr("technical_debt_tolerance");
  const debtFactor = architectural ? policy.debt.base - policy.debt.slope * tolerance : 1;
  const topicFactor = policy.topicScale.base + policy.topicScale.slope * topicWeight;
  const scaled = clamp01(sigma * debtFactor * topicFactor);

  const base = { finding, sigma, topic, topicWeight, architectural };

  if (sigma >= NON_SUPPRESSIBLE_SIGMA) {
    return {
      ...base,
      effective: Math.max(scaled, sigma),
      disposition: "request_changes",
      reason: `σ ${fmt(sigma)} (${finding.severity}) is at or above the ${NON_SUPPRESSIBLE_SIGMA} floor no profile can lower`,
    };
  }

  if (sigma < COSMETIC_SIGMA) {
    const pedantry = attr("pedantry_level");
    const disposition: Disposition =
      pedantry < policy.pedantry.dropBelow
        ? "drop"
        : pedantry < policy.pedantry.commentAtOrAbove
          ? "nit"
          : "comment";
    return {
      ...base,
      effective: scaled,
      disposition,
      reason: `cosmetic (σ ${fmt(sigma)} < ${COSMETIC_SIGMA}) at pedantry ${fmt(pedantry)}`,
    };
  }

  const threshold = attr("blocking_threshold");
  const against = `S_effective ${fmt(scaled)} against blocking threshold ${fmt(threshold)}`;
  if (scaled >= threshold) {
    if (
      architectural &&
      tolerance >= policy.debt.trackedTicketMinTolerance &&
      sigma < policy.debt.trackedTicketBelowSigma
    ) {
      return {
        ...base,
        effective: scaled,
        disposition: "comment",
        followUp: "tracked_ticket",
        reason: `${against}; an architectural shortcut under debt tolerance ${fmt(tolerance)} is tracked rather than blocked`,
      };
    }
    return { ...base, effective: scaled, disposition: "request_changes", reason: against };
  }
  if (scaled >= threshold - policy.commentBand) {
    return {
      ...base,
      effective: scaled,
      disposition: "comment",
      reason: `${against}, within the comment band`,
    };
  }
  return {
    ...base,
    effective: scaled,
    disposition: "note",
    reason: `${against}, below the comment band`,
  };
}

export function applyProfile<T extends GateableFinding>(
  findings: readonly T[],
  profile: DeveloperCognitiveProfile,
  policy: ProfilePolicy = DEFAULT_PROFILE_POLICY,
): ProfiledReview<T> {
  const kept: ProfiledFinding<T>[] = [];
  const dropped: ProfiledFinding<T>[] = [];
  for (const finding of findings) {
    const assessed = assessFinding(finding, profile, policy);
    (assessed.disposition === "drop" ? dropped : kept).push(assessed);
  }
  return {
    kept,
    dropped,
    state: kept.some((f) => f.disposition === "request_changes") ? "REQUEST_CHANGES" : "COMMENT",
  };
}
