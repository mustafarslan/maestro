import { type Finding, runReviewAgent, severityAtLeast } from "@maestro/agents";
import { logger, type SpanRecorder, type SqlDatabase } from "@maestro/core";
import type { Provider, ProviderRegistry } from "@maestro/llm";
import {
  type EnvSpec,
  GateConfigSchema,
  type GraphNode,
  type PlaybookDocument,
  type PromptContext,
} from "@maestro/playbook";
import type { PreparedEnvironment, Sandbox, SandboxDriver } from "@maestro/sandbox";
import { type RouteDecision, route } from "./router.js";
import { type AgentFindings, type TriageResult, triage } from "./triage.js";

export interface EngineDeps {
  driver: SandboxDriver;
  registry: ProviderRegistry;
  spans?: SpanRecorder;
  /** When present, per-step model calls are persisted as they happen. */
  db?: SqlDatabase;
  /**
   * Admission control for agent tasks, supplied by the daemon.
   *
   * The engine deliberately does not own this: a single `maestro review` has nothing to
   * schedule against, while the daemon must hold limits across every concurrent review.
   * Without it every agent of every review starts at once — which is how the product
   * agent saturating PR #1 stops the other agents flowing to PR #2.
   *
   * Resolves with a release function once a slot is free.
   */
  acquireSlot?: (
    req: { reviewId: string; agentId: string; repoId: string; providerId: string },
    signal?: AbortSignal,
  ) => Promise<() => void>;
}

export interface ReviewRequest {
  reviewId: string;
  /** Used for the scheduler's per-repo limit; defaults to the review's own id. */
  repoId?: string;
  playbook: PlaybookDocument;
  sourcePath: string;
  baseRef: string;
  changedFiles: string[];
  changedLines: number;
  context: PromptContext;
  envSpec?: EnvSpec;
  /**
   * Called as the run moves between stages.
   *
   * `REVIEW_STATES` has declared `analyzing` and `triaging` since the first migration,
   * `IN_FLIGHT_STATES` contains both, and one comment in `reviews.ts` describes an
   * interrupted review sitting in `analyzing` — which could never have happened, because
   * nothing wrote either. A review went `preparing` straight to `posting`, so the live
   * board showed `preparing` for the whole analyze phase: 156 of 158 seconds on the first
   * real run. Phase 5's exit criterion is that you can watch a review happen in the
   * browser, and the stage you watched was wrong for almost all of it.
   *
   * The engine reports; the caller decides what to do with it, because the engine does
   * not own the review row.
   */
  onStage?: (stage: "analyzing" | "triaging") => void;
  /**
   * Set when the fork point could not be found, so `git_diff` compares two points
   * rather than the change. The findings still stand on their own, but the diff the
   * agents read includes commits this pull request did not make.
   */
  diffDegraded?: boolean;
  signal?: AbortSignal;
}

/**
 * Roughly three characters per token, against the model's own context window, leaving
 * headroom for the reply. Unknown models keep the conservative default in the loop.
 */
function promptCharBudget(provider: Provider, model: string): number | undefined {
  const window = provider.capabilities(model).contextWindow;
  return window ? Math.floor(window * 3 * 0.8) : undefined;
}

/**
 * Applies one gate node's filter to the findings collected so far.
 *
 * A malformed config is a pass-through, not a silent drop: rejecting every finding
 * because someone typed a bad threshold would hide real defects and look like a clean
 * review, which is the most expensive way this could fail.
 */
function applyGate(node: GraphNode, results: AgentFindings[]): AgentFindings[] {
  const parsed = GateConfigSchema.safeParse(node.config);
  if (!parsed.success) {
    logger.warn(
      { nodeId: node.id, issues: parsed.error.issues.map((i) => i.message) },
      "gate config is invalid; passing findings through unfiltered",
    );
    return results;
  }
  const gate = parsed.data;
  const floor = gate.minSeverity;
  const excluded = new Set(gate.excludeCategories.map((c) => c.toLowerCase()));

  return results.map((r) => ({
    ...r,
    findings: r.findings.filter((f) => {
      if (gate.minConfidence !== undefined && f.confidence < gate.minConfidence) return false;
      if (floor !== undefined && !severityAtLeast(f.severity, floor)) return false;
      if (excluded.has(f.category.toLowerCase())) return false;
      return true;
    }),
  }));
}

/**
 * Runs a node, honouring its failure policy.
 *
 * `failurePolicy` was read in exactly one place — the agent loop — so on every other node
 * it was a setting the Studio offered and nothing consulted. `fail-review` still throws;
 * `skip-with-note` falls back to the value supplied here, which for a router is "run
 * every agent" and for triage is "an empty review". Both are worse reviews than intended
 * and both are better than no review at all.
 */
async function withFailurePolicy<T>(
  node: GraphNode,
  // A thunk, not a value: computing the fallback eagerly evaluates it OUTSIDE this try,
  // so a fallback that can itself throw — triage on a malformed playbook does — takes
  // the review down by the very path this exists to prevent. Caught by a test that
  // expected the fallback and got a failed review.
  fallback: () => T,
  log: { warn: (obj: object, msg: string) => void },
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (node.failurePolicy === "fail-review") throw err;
    log.warn(
      { nodeId: node.id, kind: node.kind, err: err instanceof Error ? err.message : String(err) },
      "node failed; continuing under skip-with-note",
    );
    return fallback();
  }
}

/**
 * What a failed triage degrades to: an empty review that still posts.
 *
 * Built as a literal rather than by calling triage() with no findings, because the
 * fallback for "triage threw" must not itself be a call to triage.
 */
const EMPTY_TRIAGE: TriageResult = {
  posted: [],
  suppressed: [],
  summary: "Triage did not complete; findings could not be consolidated.",
};

export interface NodeOutcome {
  nodeId: string;
  kind: string;
  agentId?: string;
  state: "done" | "failed" | "skipped";
  durationMs: number;
  costCents: number;
  error?: string;
  findings?: number;
  commandsRun?: { command: string; exitCode: number; durationMs: number; refused?: boolean }[];
  model?: string;
  stopKind?: string;
}

export interface ReviewOutcome {
  /** The tracker issue this PR was checked against, when one was found. */
  linearIssue?: { identifier: string; title: string; acceptanceCriteria?: string };
  reviewId: string;
  /** False when a provider has no pricing data, so cost is unknown rather than zero. */
  costKnown?: boolean;
  /** True when a setup step failed, making command output unreliable evidence. */
  setupFailed?: boolean;
  /** True when the diff the agents read is a two-point comparison, not the change. */
  diffDegraded?: boolean;
  state: "done" | "failed" | "skipped";
  skipReason?: string;
  route?: RouteDecision;
  triage?: TriageResult;
  nodes: NodeOutcome[];
  costCents: number;
  durationMs: number;
  toolchain?: string;
  /**
   * Whether the dependency install reused the cached layer.
   *
   * The sandbox driver has computed this from the first day — it is the single biggest
   * lever on how long a review takes — and nothing read it, so the one number that says
   * whether the cache is working was measured and discarded. An operator asking "why is
   * every review taking four minutes" had no way to see that it never hits.
   */
  cacheHit?: boolean;
  allowedCommands: string[];
  egressLog: { host: string; allowed: boolean; count: number }[];
  /** Which posture produced that log; the review comment must not report the two alike. */
  egressEnforcement?: "enforced" | "advisory" | "none";
  error?: string;
}

/**
 * The graph interpreter.
 *
 * Node executors are keyed off the closed registry, so adding an agent to a playbook is
 * a data change and adding a node *type* is a code change — which is exactly the split
 * that keeps a user-editable canvas safe.
 *
 * Teardown is not a node. It is a finalizer that runs on every terminal state, including
 * a thrown error or an abort, so no drawable graph can leak containers.
 */
export async function runReview(deps: EngineDeps, req: ReviewRequest): Promise<ReviewOutcome> {
  const startedAt = Date.now();
  const log = logger.child({ reviewId: req.reviewId });
  const spec = req.envSpec ?? req.playbook.envSpec;
  const nodes: NodeOutcome[] = [];

  let prepared: PreparedEnvironment | undefined;
  const sandboxes: Sandbox[] = [];

  // Environment rows exist so a crash can be reconciled against Docker afterwards, and
  // so the admin UI can show what is running. Nothing wrote them until now, which left
  // the environments view permanently empty and reap's row-closing a no-op.
  const envRecorder = deps.db
    ? new (await import("./recorder.js")).ReviewRecorder(deps.db)
    : undefined;
  const recordEnv = (
    id: string,
    kind: "prepare" | "analyze",
    over: { agentId?: string; containerId?: string; imageId?: string } = {},
  ) => {
    try {
      envRecorder?.recordEnvironment(req.reviewId, {
        id,
        kind,
        ...over,
        ttlMs: (spec.timeouts.prepareSec + spec.timeouts.analyzeSec) * 1000,
        spec,
      });
    } catch (err) {
      // Bookkeeping must never fail a review.
      log.warn({ err: err instanceof Error ? err.message : err }, "environment record failed");
    }
  };
  let totalCost = 0;
  let modelSteps = 0;

  const finish = (over: Partial<ReviewOutcome>): ReviewOutcome => ({
    reviewId: req.reviewId,
    state: "done",
    nodes,
    costCents: totalCost,
    // Steps ran but nothing was charged => the model is not in the pricing table.
    costKnown: !(modelSteps > 0 && totalCost === 0),
    durationMs: Date.now() - startedAt,
    toolchain: prepared?.toolchain.kind,
    linearIssue: req.context.linear?.identifier
      ? {
          identifier: req.context.linear.identifier,
          title: req.context.linear.title ?? "",
          acceptanceCriteria: req.context.linear.acceptanceCriteria,
        }
      : undefined,
    setupFailed: prepared?.setupResults.some((r) => r.exitCode !== 0) ?? false,
    diffDegraded: req.diffDegraded,
    cacheHit: prepared?.cacheHit,
    allowedCommands: prepared?.allowedCommands ?? [],
    egressLog: prepared?.egressLog ?? [],
    egressEnforcement: prepared?.egressEnforcement,
    ...over,
  });

  try {
    const byKind = (kind: GraphNode["kind"]) =>
      req.playbook.graph.nodes.filter((n) => n.kind === kind);

    // ── prepare-env ────────────────────────────────────────────────────────
    const prepareNode = byKind("prepare-env")[0];
    if (!prepareNode) return finish({ state: "failed", error: "playbook has no prepare-env node" });

    prepared = await timedNode(nodes, prepareNode, deps.spans, req.reviewId, async () => {
      const env = await deps.driver.prepare({
        reviewId: req.reviewId,
        sourcePath: req.sourcePath,
        spec,
        signal: req.signal,
      });
      log.info(
        { toolchain: env.toolchain.kind, commands: env.allowedCommands, cacheHit: env.cacheHit },
        "environment ready",
      );
      return env;
    });

    // ── router ─────────────────────────────────────────────────────────────
    const routerNode = byKind("router")[0];
    let decision: RouteDecision = {
      activeAgentIds: req.playbook.agents.filter((a) => a.enabled).map((a) => a.id),
      skipped: [],
      costCapCents: req.playbook.router.budgetTiers.at(-1)?.costCapCents ?? 200,
    };
    if (routerNode) {
      // `failurePolicy` was honoured only for agent nodes: on a router it was dead
      // config, and a router that threw killed a review that could have run every agent
      // instead. Under skip-with-note the default decision above stands — a coarser
      // review, not a lost one.
      decision = await withFailurePolicy(
        routerNode,
        () => decision,
        log,
        () =>
          timedNode(nodes, routerNode, deps.spans, req.reviewId, async () =>
            route(req.playbook, {
              changedFiles: req.changedFiles,
              changedLines: req.changedLines,
              author: req.context.pr?.author,
            }),
          ),
      );
      if (decision.skipReview) {
        log.info({ reason: decision.skipReview }, "review skipped by router");
        return finish({ state: "skipped", skipReason: decision.skipReview, route: decision });
      }
    }

    // ── agent nodes, in parallel, each in its own container ────────────────
    req.onStage?.("analyzing");
    const agentNodes = byKind("agent").filter(
      (n) => n.agentId && decision.activeAgentIds.includes(n.agentId),
    );
    for (const n of byKind("agent")) {
      if (!agentNodes.includes(n)) {
        const reason =
          decision.skipped.find((s) => s.agentId === n.agentId)?.reason ??
          "not selected by the router";
        nodes.push({
          nodeId: n.id,
          kind: n.kind,
          agentId: n.agentId,
          state: "skipped",
          durationMs: 0,
          costCents: 0,
          error: reason,
        });
      }
    }

    // Bound once here: `prepare-env` has completed by this point, so the closures below
    // do not need to re-assert it.
    const readyEnv = prepared;
    const agentResults = await Promise.all(
      agentNodes.map(async (node) => {
        const agent = req.playbook.agents.find((a) => a.id === node.agentId);
        if (!agent) return null;

        // Everything that can fail belongs inside the try, including resolving the
        // model binding: an agent pointed at a provider with no key is exactly the
        // per-agent failure `skip-with-note` exists for, and outside the try it would
        // reject Promise.all and take the whole review down instead.
        let release: (() => void) | undefined;
        let started = Date.now();

        try {
          const binding = deps.registry.resolve(agent.model);

          // Wait for a slot BEFORE creating the container: admitting first and queueing
          // second would hold a container, its memory and its disk for the whole wait.
          release = await deps.acquireSlot?.(
            {
              reviewId: req.reviewId,
              agentId: agent.id,
              repoId: req.repoId ?? req.reviewId,
              providerId: binding.provider.id,
            },
            // Abort removes this from the queue instead of leaving it to displace live
            // work until it is admitted and immediately abandoned.
            req.signal,
          );

          // A review superseded while this task queued must not start a container it is
          // about to abandon. Under cancel-on-push and load that is one container start
          // per agent, for nothing.
          if (req.signal?.aborted) return null;

          // The clock starts after admission, so queueing time is not reported as the
          // agent being slow.
          started = Date.now();

          // Each agent gets its OWN container off the shared snapshot: concurrent agents
          // running builds would otherwise clobber one another's working directory.
          const sandbox = await deps.driver.analyze(readyEnv, { agentId: agent.id, spec });
          sandboxes.push(sandbox);
          recordEnv(sandbox.id, "analyze", {
            agentId: agent.id,
            containerId: sandbox.containerId,
            imageId: readyEnv.imageId,
          });

          const result = await runReviewAgent({
            agent,
            provider: binding.provider,
            model: binding.model,
            sandbox,
            allowedCommands: readyEnv.allowedCommands,
            baseRef: req.baseRef,
            commandTimeoutSec: spec.timeouts.commandSec,
            setupFailed: readyEnv.setupResults.some((r) => r.exitCode !== 0),
            writableWorkdir: spec.writableWorkdir,
            context: req.context,
            // So an agent's log lines can be tied back to the review and the graph node
            // they came from. Three agents run concurrently across several reviews, and
            // `agentId` alone matches lines from all of them.
            reviewId: req.reviewId,
            nodeId: node.id,
            budget: {
              // The router's tier caps the whole review; an agent may not exceed its own
              // binding either, so the tighter of the two wins.
              maxSteps: agent.model.maxSteps,
              costCapCents: Math.min(agent.model.costCapCents, decision.costCapCents),
              deadlineMs: spec.timeouts.analyzeSec * 1000,
              // Sized from the bound model's real window rather than one constant: a
              // 200k-token model was being trimmed at half its capacity for no reason,
              // while a smaller one was rejected by the API before the guard engaged.
              maxPromptChars: promptCharBudget(binding.provider, binding.model),
            },
            signal: req.signal,
          });

          totalCost += result.loop.costCents;
          modelSteps += result.loop.steps.length;

          // One decision, used for both the task row and the outcome below. It was written
          // out twice, so the database and the metrics block each decided separately
          // whether the same agent run had finished, and a change to one would have left
          // them disagreeing about it. Mutation is what surfaced the duplication: patching
          // one copy left the whole suite green, because the test read the other.
          //
          // A run the context window cut short produced partial work at best; recording it
          // as "done" hides that from whoever reads the metrics block.
          const agentState = result.loop.stopKind === "context-limit" ? "failed" : "done";

          if (deps.db) {
            const { ReviewRecorder } = await import("./recorder.js");
            const recorder = new ReviewRecorder(deps.db);
            const taskId = recorder.recordNode(req.reviewId, {
              nodeId: node.id,
              kind: node.kind,
              agentId: agent.id,
              state: agentState,
              durationMs: Date.now() - started,
              costCents: result.loop.costCents,
              findings: result.findings.length,
              commandsRun: result.commandLog,
              model: binding.model,
              stopKind: result.loop.stopKind,
            });
            recorder.recordLoop(
              req.reviewId,
              taskId,
              binding.provider.id,
              binding.model,
              result.loop,
            );
          }
          nodes.push({
            nodeId: node.id,
            kind: node.kind,
            agentId: agent.id,
            state: agentState,
            durationMs: Date.now() - started,
            costCents: result.loop.costCents,
            findings: result.findings.length,
            commandsRun: result.commandLog,
            model: binding.model,
            stopKind: result.loop.stopKind,
            error: result.parseError,
          });
          return { agentId: agent.id, findings: result.findings, summary: result.summary };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // A cancelled review did not fail; reporting it as failed would put a red row
          // in the metrics for work that was correctly abandoned.
          if (req.signal?.aborted) {
            nodes.push({
              nodeId: node.id,
              kind: node.kind,
              agentId: node.agentId,
              state: "skipped",
              durationMs: Date.now() - started,
              costCents: 0,
              error: "review cancelled",
            });
            return null;
          }
          // A per-node failure policy is what stops one flaky agent from killing a review.
          const fatal = node.failurePolicy === "fail-review";
          log.warn(
            { nodeId: node.id, agentId: node.agentId, err: message, fatal },
            "agent node failed",
          );
          nodes.push({
            nodeId: node.id,
            kind: node.kind,
            agentId: node.agentId,
            state: "failed",
            durationMs: Date.now() - started,
            costCents: 0,
            error: message,
          });
          if (fatal) throw err;
          return null;
        } finally {
          // Must run on every path including a fatal throw, or one failing agent leaks a
          // slot and the pool drains until the daemon stalls.
          release?.();
        }
      }),
    );

    let collected: AgentFindings[] = agentResults.filter(
      (r): r is NonNullable<typeof r> => r !== null,
    );

    // ── gates ──────────────────────────────────────────────────────────────
    // Gate nodes were drawable, documented as "filter findings before triage", accepted
    // by the validator — and never executed. A user who added one to drop low-confidence
    // findings got no filtering and no indication of it, which is worse than the feature
    // being absent: they believed a safety filter was in place.
    for (const gateNode of byKind("gate")) {
      const before = collected.reduce((n, r) => n + r.findings.length, 0);
      collected = await timedNode(nodes, gateNode, deps.spans, req.reviewId, async () =>
        applyGate(gateNode, collected),
      );
      const after = collected.reduce((n, r) => n + r.findings.length, 0);
      log.info({ nodeId: gateNode.id, before, after }, "gate applied");
    }

    // ── triage ─────────────────────────────────────────────────────────────
    req.onStage?.("triaging");
    const triageNode = byKind("triage")[0];
    const triaged = triageNode
      ? await withFailurePolicy(
          triageNode,
          () => EMPTY_TRIAGE,
          log,
          () =>
            timedNode(nodes, triageNode, deps.spans, req.reviewId, async () =>
              triage(req.playbook, collected),
            ),
        )
      : triage(req.playbook, collected);

    // ── post (the caller renders or publishes; the node records the step) ──
    const postNode = byKind("post")[0];
    if (postNode) {
      nodes.push({
        nodeId: postNode.id,
        kind: postNode.kind,
        state: "done",
        durationMs: 0,
        costCents: 0,
      });
    }

    return finish({ state: "done", route: decision, triage: triaged });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message }, "review failed");
    return finish({ state: "failed", error: message });
  } finally {
    // Guaranteed finalizer: runs on success, failure and abort alike.
    const outcomes = await Promise.allSettled(sandboxes.map((s) => s.destroy()));
    // A sandbox that would not destroy is exactly what the record is for: it is marked
    // leaked rather than destroyed, so the next reap has something to reconcile against.
    sandboxes.forEach((sandbox, i) => {
      try {
        envRecorder?.closeEnvironment(
          sandbox.id,
          outcomes[i]?.status === "fulfilled" ? "destroyed" : "leaked",
        );
      } catch {
        // Already logged by the recorder; teardown must complete regardless.
      }
    });
    if (prepared) {
      await deps.driver.reap({ reviewId: req.reviewId }).catch((err) => {
        logger.error({ reviewId: req.reviewId, err }, "reap failed; run 'maestro doctor'");
      });
    }
  }
}

async function timedNode<T>(
  nodes: NodeOutcome[],
  node: GraphNode,
  spans: SpanRecorder | undefined,
  reviewId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  const spanId = spans?.start(`node:${node.kind}`, { reviewId }, { nodeId: node.id });
  try {
    const out = await fn();
    if (spanId) spans?.end(spanId, "ok");
    nodes.push({
      nodeId: node.id,
      kind: node.kind,
      state: "done",
      durationMs: Date.now() - started,
      costCents: 0,
    });
    return out;
  } catch (err) {
    if (spanId) spans?.end(spanId, "error");
    nodes.push({
      nodeId: node.id,
      kind: node.kind,
      state: "failed",
      durationMs: Date.now() - started,
      costCents: 0,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export type { Finding };
