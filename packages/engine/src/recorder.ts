import { newId, type SqlDatabase } from "@maestro/core";
import type { LoopResult } from "@maestro/llm";
import type { NodeOutcome, ReviewOutcome } from "./engine.js";
import type { TriagedFinding } from "./triage.js";

/**
 * Persists what a review actually did.
 *
 * Without this the run is invisible the moment the process exits: the admin UI has no
 * waterfall to draw, and Phase 9 has nothing to measure precision against. Every row is
 * keyed by review id, and findings carry the agent that raised them so accepted/dismissed
 * rates can later be attributed per agent.
 */
export class ReviewRecorder {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Returns the id of the row that now exists for this (review, node).
   *
   * On a re-review the upsert keeps the ORIGINAL row and its id; returning the freshly
   * generated one made every subsequent llm_calls insert fail its foreign key.
   */
  /**
   * Records a sandbox the engine created.
   *
   * The `environments` table was read by the admin API and updated by `reap`, and
   * nothing ever inserted a row — so the environments view was permanently empty, reap's
   * "stale rows closed" never fired, and the lease-and-TTL leak record the design
   * describes did not exist. Containers were not actually leaking, because the engine's
   * finalizer and the reaper's label sweep both work; what was missing was the record
   * that lets anyone reconcile the two after a crash.
   */
  recordEnvironment(
    reviewId: string,
    env: {
      id: string;
      kind: "prepare" | "analyze";
      agentId?: string;
      containerId?: string;
      imageId?: string;
      workdir?: string;
      ttlMs: number;
      spec: unknown;
    },
  ): void {
    const now = new Date();
    this.db
      .prepare(
        `INSERT INTO environments (id, review_id, kind, agent_id, container_id, image_id,
                                   workdir, state, spec_json, lease_until, ttl_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           container_id=excluded.container_id, image_id=excluded.image_id, state='running'`,
      )
      .run(
        env.id,
        reviewId,
        env.kind,
        env.agentId ?? null,
        env.containerId ?? null,
        env.imageId ?? null,
        env.workdir ?? null,
        JSON.stringify(env.spec ?? {}),
        new Date(now.getTime() + env.ttlMs).toISOString(),
        new Date(now.getTime() + env.ttlMs).toISOString(),
        now.toISOString(),
      );
  }

  /** Closes an environment row when its sandbox is torn down. */
  closeEnvironment(id: string, state: "destroyed" | "leaked" = "destroyed"): void {
    this.db
      .prepare("UPDATE environments SET state=?, destroyed_at=? WHERE id=?")
      .run(state, new Date().toISOString(), id);
  }

  recordNode(reviewId: string, node: NodeOutcome): string {
    const id = newId("tk");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tasks (id, review_id, node_id, kind, agent_id, state, attempt, max_attempts,
                            output_json, error, tokens_in, tokens_out, cost_cents, created_at, finished_at)
         VALUES (?,?,?,?,?,?,1,1,?,?,?,?,?,?,?)
         ON CONFLICT(review_id, node_id) DO UPDATE SET
           state=excluded.state, error=excluded.error, cost_cents=excluded.cost_cents,
           output_json=excluded.output_json, finished_at=excluded.finished_at`,
      )
      .run(
        id,
        reviewId,
        node.nodeId,
        node.kind,
        node.agentId ?? null,
        node.state,
        JSON.stringify({
          findings: node.findings,
          commandsRun: node.commandsRun,
          model: node.model,
          stopKind: node.stopKind,
        }),
        node.error ?? null,
        0,
        0,
        node.costCents,
        now,
        now,
      );

    const row = this.db
      .prepare("SELECT id FROM tasks WHERE review_id=? AND node_id=?")
      .get<{ id: string }>(reviewId, node.nodeId);
    return row?.id ?? id;
  }

  /** One row per model call, so cost and latency are attributable per step. */
  recordLoop(
    reviewId: string,
    taskId: string,
    providerId: string,
    model: string,
    loop: LoopResult,
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO llm_calls (id, task_id, review_id, provider_id, model, step, tokens_in, tokens_out,
                              cache_read, cache_write, cost_cents, latency_ms, finish_reason, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const step of loop.steps) {
      stmt.run(
        newId("call"),
        taskId,
        reviewId,
        providerId,
        model,
        step.index,
        step.response.usage.inputTokens,
        step.response.usage.outputTokens,
        step.response.usage.cacheReadTokens,
        step.response.usage.cacheWriteTokens,
        step.costCents,
        step.response.latencyMs,
        step.response.finishReason,
        new Date().toISOString(),
      );
    }
  }

  /**
   * @param taskByAgent Which task produced each agent's findings, so a finding can be
   *   traced back to the transcript that produced it.
   */
  recordFindings(
    reviewId: string,
    posted: TriagedFinding[],
    suppressed: TriagedFinding[],
    taskByAgent: ReadonlyMap<string, string> = new Map(),
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO findings (id, review_id, task_id, agent_id, file, line_start, line_end, category,
                             severity, confidence, title, body, evidence_json, dedupe_group,
                             agreement_count, suppressed_reason, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const now = new Date().toISOString();
    const write = (f: TriagedFinding, status: string) =>
      stmt.run(
        newId("fd"),
        reviewId,
        // Only when exactly one agent produced it.
        //
        // The column was in the schema from the start and never written, so it was a
        // documented link that resolved to nothing. Filling it in with `agentIds[0]` for
        // merged findings would have been worse than leaving it empty: after dedupe that
        // is whichever agent happened to be processed first, not the one whose text
        // survived — triage keeps the fuller body without reordering the agent list — so
        // the link would point at a transcript that need not contain the words above it.
        //
        // A merged finding therefore keeps NULL here, and the UI resolves every one of
        // its agents through the review's own task list instead. N transcripts for a
        // finding N agents agreed on is the truth; one arbitrary transcript is not.
        f.agentIds.length === 1 ? (taskByAgent.get(f.agentIds[0] as string) ?? null) : null,
        f.agentIds.join(","),
        f.file ?? null,
        f.lineStart ?? null,
        f.lineEnd ?? null,
        f.category,
        f.severity,
        f.confidence,
        f.title,
        f.body,
        f.evidence ? JSON.stringify({ evidence: f.evidence }) : null,
        // The group triage actually formed, not a key recomputed from two fields that
        // stopped being the grouping rule.
        f.dedupeGroup,
        f.agreementCount,
        f.suppressedReason ?? null,
        status,
        now,
      );

    this.db.transaction(() => {
      for (const f of posted) write(f, "open");
      for (const f of suppressed) write(f, "suppressed");
    });
  }

  recordOutcome(reviewId: string, outcome: ReviewOutcome): void {
    this.db.transaction(() => {
      // A re-review replaces its findings rather than stacking a second set on top.
      this.db.prepare("DELETE FROM findings WHERE review_id=?").run(reviewId);
      const taskByAgent = new Map<string, string>();
      for (const node of outcome.nodes) {
        const taskId = this.recordNode(reviewId, node);
        if (node.agentId) taskByAgent.set(node.agentId, taskId);
      }
      if (outcome.triage) {
        this.recordFindings(
          reviewId,
          outcome.triage.posted,
          outcome.triage.suppressed,
          taskByAgent,
        );
      }
    });
  }
}
