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
  /** Applies during `prepare` only; `analyze` always runs with --network none. */
  egressAllowlist: z
    .array(z.string())
    .default(["registry.npmjs.org", "pypi.org", "proxy.golang.org", "crates.io"]),
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
  model: ModelBindingSchema,
  persona: z.string().min(1),
  minConfidence: z.number().min(0).max(1).default(0.6),
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
