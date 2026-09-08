import { type Finding, runReviewAgent } from "@maestro/agents";
import { logger, type SpanRecorder, type SqlDatabase } from "@maestro/core";
import type { ProviderRegistry } from "@maestro/llm";
import type { EnvSpec, GraphNode, PlaybookDocument, PromptContext } from "@maestro/playbook";
import type { PreparedEnvironment, Sandbox, SandboxDriver } from "@maestro/sandbox";
import { type RouteDecision, route } from "./router.js";
import { type TriageResult, triage } from "./triage.js";

export interface EngineDeps {
  driver: SandboxDriver;
  registry: ProviderRegistry;
  spans?: SpanRecorder;
  /** When present, per-step model calls are persisted as they happen. */
  db?: SqlDatabase;
}

export interface ReviewRequest {
  reviewId: string;
  playbook: PlaybookDocument;
  sourcePath: string;
  baseRef: string;
  changedFiles: string[];
  changedLines: number;
  context: PromptContext;
  envSpec?: EnvSpec;
  signal?: AbortSignal;
}

export interface NodeOutcome {
  nodeId: string;
  kind: string;
  agentId?: string;
  state: "done" | "failed" | "skipped";
  durationMs: number;
  costCents: number;
  error?: string;
  findings?: number;
  commandsRun?: { command: string; exitCode: number; durationMs: number }[];
  model?: string;
  stopKind?: string;
}

export interface ReviewOutcome {
  reviewId: string;
  state: "done" | "failed" | "skipped";
  skipReason?: string;
  route?: RouteDecision;
  triage?: TriageResult;
  nodes: NodeOutcome[];
  costCents: number;
  durationMs: number;
  toolchain?: string;
  allowedCommands: string[];
  egressLog: { host: string; allowed: boolean }[];
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
  let totalCost = 0;

  const finish = (over: Partial<ReviewOutcome>): ReviewOutcome => ({
    reviewId: req.reviewId,
    state: "done",
    nodes,
    costCents: totalCost,
    durationMs: Date.now() - startedAt,
    toolchain: prepared?.toolchain.kind,
    allowedCommands: prepared?.allowedCommands ?? [],
    egressLog: prepared?.egressLog ?? [],
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
        { toolchain: env.toolchain.kind, commands: env.allowedCommands },
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
      decision = await timedNode(nodes, routerNode, deps.spans, req.reviewId, async () =>
        route(req.playbook, {
          changedFiles: req.changedFiles,
          changedLines: req.changedLines,
          author: req.context.pr?.author,
        }),
      );
      if (decision.skipReview) {
        log.info({ reason: decision.skipReview }, "review skipped by router");
        return finish({ state: "skipped", skipReason: decision.skipReview, route: decision });
      }
    }

    // ── agent nodes, in parallel, each in its own container ────────────────
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
        const started = Date.now();

        try {
          const binding = deps.registry.resolve(agent.model);
          // Each agent gets its OWN container off the shared snapshot: concurrent agents
          // running builds would otherwise clobber one another's working directory.
          const sandbox = await deps.driver.analyze(readyEnv, { agentId: agent.id, spec });
          sandboxes.push(sandbox);

          const result = await runReviewAgent({
            agent,
            provider: binding.provider,
            model: binding.model,
            sandbox,
            allowedCommands: readyEnv.allowedCommands,
            baseRef: req.baseRef,
            commandTimeoutSec: spec.timeouts.commandSec,
            context: req.context,
            budget: {
              // The router's tier caps the whole review; an agent may not exceed its own
              // binding either, so the tighter of the two wins.
              maxSteps: agent.model.maxSteps,
              costCapCents: Math.min(agent.model.costCapCents, decision.costCapCents),
              deadlineMs: spec.timeouts.analyzeSec * 1000,
            },
            signal: req.signal,
          });

          totalCost += result.loop.costCents;
          if (deps.db) {
            const { ReviewRecorder } = await import("./recorder.js");
            const recorder = new ReviewRecorder(deps.db);
            const taskId = recorder.recordNode(req.reviewId, {
              nodeId: node.id,
              kind: node.kind,
              agentId: agent.id,
              state: "done",
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
            state: "done",
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
        }
      }),
    );

    const collected = agentResults.filter((r): r is NonNullable<typeof r> => r !== null);

    // ── triage ─────────────────────────────────────────────────────────────
    const triageNode = byKind("triage")[0];
    const triaged = triageNode
      ? await timedNode(nodes, triageNode, deps.spans, req.reviewId, async () =>
          triage(req.playbook, collected),
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
    await Promise.allSettled(sandboxes.map((s) => s.destroy()));
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
