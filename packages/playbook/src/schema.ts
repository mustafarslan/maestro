import { z } from "zod";

export const PLAYBOOK_SCHEMA_VERSION = 1;

const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const Id = z.string().regex(idPattern, "must be kebab-case, 1-64 chars");

// ── Environment spec ─────────────────────────────────────────────────────────
export const TrustLevel = z.enum(["trusted", "untrusted"]);

export const EnvSpecSchema = z.object({
  /** "auto" resolves to a Maestro-maintained per-toolchain base image pinned by digest. */
  image: z.string().default("auto"),
  cpus: z.number().positive().max(64).default(2),
  memory: z.string().default("4GiB"),
  pids: z.number().int().positive().default(512),
  tmpfs: z.string().default("1GiB"),
  timeouts: z
    .object({
      prepareSec: z.number().int().positive().default(600),
      analyzeSec: z.number().int().positive().default(900),
      commandSec: z.number().int().positive().default(300),
    })
    .prefault({}),
  /** "auto" => detected from the toolchain (npm ci, uv sync, go mod download, cargo fetch). */
  setup: z.array(z.string()).default(["auto"]),
  /** Agents may run ONLY these. "auto" => detected test/build/lint scripts. */
  allowedCommands: z.array(z.string()).default(["auto"]),
  /**
   * Commands run at BOTH the merge-base and the head, so a pull request claiming
   * "faster", "smaller" or "fixes the failing test" can be checked rather than reasoned
   * about. Maestro runs these itself; agents receive the results as evidence.
   *
   * Opt-in, and deliberately never "auto". Every other command list can be detected from
   * the toolchain because there is a right answer — the repo's own test script is its
   * test script. Which command bears on a claim is a judgement about intent, and a
   * measurement nobody asked for is a measurement nobody should trust. An empty list
   * means the feature is off, which is the default.
   */
  compareCommands: z.array(z.string()).default([]),
  /** Applies during `prepare` only; `analyze` always runs with --network none. */
  egressAllowlist: z
    .array(z.string())
    .default(["registry.npmjs.org", "pypi.org", "proxy.golang.org", "crates.io"]),
  /**
   * Whether the allowlist above is a control or a convention.
   *
   * "enforced" gives the review its own --internal network and puts the proxy in a
   * container on it, so the sandbox has no route to the internet at all except through
   * the allowlist. "advisory" is the older posture: the proxy runs inside the daemon and
   * is offered through HTTP_PROXY, which a tool that ignores those variables simply
   * bypasses. Enforced is the default because the gap it closes is the largest one this
   * project knew about; advisory remains for hosts that cannot supply a Linux binary for
   * the proxy container, and says so in the review's metrics block rather than quietly.
   */
  egressEnforcement: z.enum(["enforced", "advisory"]).default("enforced"),
  secrets: z.literal("none").default("none"),
  trust: TrustLevel.default("trusted"),
  /**
   * Analyze runs with a read-only rootfs. Repos whose tests write into the checkout
   * (coverage output, .next, build caches) need a writable scratch overlay; it is
   * opt-in so the default posture stays locked down.
   */
  writableWorkdir: z.boolean().default(false),
});
export type EnvSpec = z.infer<typeof EnvSpecSchema>;
export type EgressEnforcement = EnvSpec["egressEnforcement"];

// ── Model binding ────────────────────────────────────────────────────────────
export const ModelBindingSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  thinkingBudget: z.number().int().positive().optional(),
  maxSteps: z.number().int().positive().default(30),
  costCapCents: z.number().positive().default(200),
  fallback: z.array(z.object({ providerId: z.string(), model: z.string() })).default([]),
});
export type ModelBinding = z.infer<typeof ModelBindingSchema>;

// ── Agents ───────────────────────────────────────────────────────────────────
export const AGENT_TOOLS = [
  "read_file",
  "list_dir",
  "grep",
  "git_diff",
  "git_log",
  "git_blame",
  "run_command",
] as const;

export const AgentSchema = z.object({
  id: Id,
  name: z.string().min(1),
  /**
   * The EDITABLE slot only. Maestro wraps this with a fixed preamble (untrusted-content
   * rules, tool contract) and a fixed output contract. Those are not editable, so no
   * persona edit can remove the injection defenses.
   */
  persona: z.string().min(1),
  model: ModelBindingSchema,
  tools: z.array(z.enum(AGENT_TOOLS)).default([...AGENT_TOOLS]),
  enabled: z.boolean().default(true),
});
export type Agent = z.infer<typeof AgentSchema>;

// ── Router ───────────────────────────────────────────────────────────────────
export const RouterRuleSchema = z.object({
  agentId: Id,
  /** Any match activates the agent. */
  include: z.array(z.string()).default(["**"]),
  exclude: z.array(z.string()).default([]),
});

export const RouterSchema = z.object({
  /** Deterministic by default: a fresh install needs only one provider key, and
   *  routing decisions stay inspectable and unit-testable. */
  mode: z.enum(["deterministic", "llm"]).default("deterministic"),
  model: ModelBindingSchema.optional(),
  rules: z.array(RouterRuleSchema).default([]),
  /**
   * Whether a pull request's own lifecycle starts a review.
   *
   * True keeps the default behaviour: opened, reopened, ready_for_review and every push
   * trigger one. False makes reviews opt-in per pull request — nothing runs until
   * somebody with write access comments `@maestro review`. That is the right setting for
   * a busy repository where most changes do not want a machine opinion, and for anyone
   * who would rather pay per review than per push.
   */
  automaticTriggers: z.boolean().default(true),
  skipAuthors: z.array(z.string()).default(["dependabot[bot]", "renovate[bot]"]),
  skipIfOnlyPaths: z.array(z.string()).default([]),
  budgetTiers: z
    .array(
      z.object({
        maxChangedLines: z.number().int().positive(),
        costCapCents: z.number().positive(),
      }),
    )
    .default([
      { maxChangedLines: 200, costCapCents: 50 },
      { maxChangedLines: 2000, costCapCents: 200 },
      { maxChangedLines: 100000, costCapCents: 600 },
    ]),
});

// ── Triage ───────────────────────────────────────────────────────────────────
export const TriageSchema = z.object({
  /** The triage agent's model. Called only when a developer profile is active. */
  model: ModelBindingSchema,
  /**
   * The triage agent's persona, read only when a developer profile is active.
   *
   * Without a profile, triage is deterministic — dedupe, agreement, thresholds and caps —
   * and this text changes nothing. With one, the triage agent reads it alongside the
   * developer's profile and decides the final review within rules kept in code.
   */
  persona: z.string().min(1),
  minConfidence: z.number().min(0).max(1).default(0.6),
  /**
   * Caps the findings triage marks as posted, which is what the summary comment renders
   * and what any inline comment is drawn from — so it bounds both. Named for the plan's
   * wording rather than for the narrower thing it does.
   */
  maxInlineComments: z.number().int().positive().default(15),
  /** Cross-agent agreement raises confidence rather than duplicating a comment. */
  agreementBoost: z.number().min(0).max(1).default(0.15),
});

// ── Graph ────────────────────────────────────────────────────────────────────

/**
 * Configuration for a `gate` node.
 *
 * A gate drops findings before triage sees them. Everything is optional, and a gate with
 * no settings is deliberately a pass-through rather than an error — an empty gate on the
 * canvas should do nothing, not reject every finding.
 */
export const GateConfigSchema = z.object({
  minConfidence: z.number().min(0).max(1).optional(),
  minSeverity: z.enum(["critical", "high", "medium", "low", "info"]).optional(),
  /** Category slugs to drop outright, e.g. a category a team has decided is noise. */
  excludeCategories: z.array(z.string()).default([]),
});
export type GateConfig = z.infer<typeof GateConfigSchema>;
export const GraphNodeSchema = z.object({
  id: Id,
  kind: z.enum(["prepare-env", "router", "agent", "gate", "triage", "post"]),
  /** Only for kind === "agent": which agent definition this node runs. */
  agentId: Id.optional(),
  failurePolicy: z.enum(["fail-review", "skip-with-note"]).default("skip-with-note"),
  config: z.record(z.string(), z.unknown()).prefault({}),
  /** Canvas coordinates. Presentation only; the engine ignores them. */
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  from: Id,
  to: Id,
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

/**
 * Aggregate spend limits, measured over a rolling 24 hours.
 *
 * A router tier caps one review and a model binding caps one agent; neither can see that
 * a repository has run two hundred reviews today. Both are optional and unset by default,
 * because a cap that arrives without being asked for silently stops reviewing.
 */
export const SpendCapsSchema = z.object({
  dailyCapCents: z.number().positive().optional(),
  perRepoDailyCapCents: z.number().positive().optional(),
});

export const PlaybookDocumentSchema = z.object({
  schemaVersion: z.literal(PLAYBOOK_SCHEMA_VERSION),
  name: z.string().min(1),
  description: z.string().default(""),
  graph: z.object({
    nodes: z.array(GraphNodeSchema).min(1),
    edges: z.array(GraphEdgeSchema).default([]),
  }),
  agents: z.array(AgentSchema).default([]),
  router: RouterSchema.prefault({}),
  triage: TriageSchema,
  envSpec: EnvSpecSchema.prefault({}),
  budget: SpendCapsSchema.prefault({}),
});
export type PlaybookDocument = z.infer<typeof PlaybookDocumentSchema>;
