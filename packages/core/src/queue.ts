import { newId } from "./ids.js";
import type { SqlDatabase } from "./store/driver.js";

export interface Job {
  id: string;
  kind: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

interface JobRow {
  id: string;
  kind: string;
  payload_json: string;
  attempts: number;
  max_attempts: number;
}

export interface EnqueueOptions {
  kind: string;
  payload: unknown;
  /** Collapses duplicate work — e.g. two webhook deliveries for the same head SHA. */
  dedupeKey?: string;
  runAfter?: Date;
  priority?: number;
  maxAttempts?: number;
}

export class JobQueue {
  constructor(
    private readonly db: SqlDatabase,
    private readonly workerId: string = `w_${process.pid}`,
  ) {}

  enqueue(opts: EnqueueOptions): string | null {
    const now = new Date().toISOString();
    const id = newId("job");
    // A duplicate dedupe_key means the work is already queued; that is success, not an error.
    const res = this.db
      .prepare(
        `INSERT INTO jobs (id, kind, payload_json, dedupe_key, priority, run_after,
                           max_attempts, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
         ON CONFLICT(dedupe_key) DO NOTHING`,
      )
      .run(
        id,
        opts.kind,
        JSON.stringify(opts.payload ?? null),
        opts.dedupeKey ?? null,
        opts.priority ?? 0,
        (opts.runAfter ?? new Date()).toISOString(),
        opts.maxAttempts ?? 5,
        now,
        now,
      );
    return res.changes > 0 ? id : null;
  }

  /**
   * Claim under BEGIN IMMEDIATE so the select and the update cannot interleave with
   * another worker. `locked_until` is a lease: a worker that dies holds it only until
   * expiry, after which the job is claimable again.
   */
  claim(leaseMs = 60_000, kinds?: string[]): Job | null {
    return this.db.transaction(() => {
      const now = new Date();
      const nowIso = now.toISOString();
      const filter = kinds?.length ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
      const row = this.db
        .prepare(
          `SELECT id, kind, payload_json, attempts, max_attempts FROM jobs
           WHERE state IN ('queued','running')
             AND run_after <= ?
             AND (locked_until IS NULL OR locked_until < ?)${filter}
           ORDER BY priority DESC, run_after ASC
           LIMIT 1`,
        )
        .get<JobRow>(nowIso, nowIso, ...(kinds ?? []));
      if (!row) return null;

      this.db
        .prepare(
          `UPDATE jobs SET state='running', locked_by=?, locked_until=?, attempts=attempts+1,
                           updated_at=? WHERE id=?`,
        )
        .run(this.workerId, new Date(now.getTime() + leaseMs).toISOString(), nowIso, row.id);

      return {
        id: row.id,
        kind: row.kind,
        payload: JSON.parse(row.payload_json) as unknown,
        attempts: row.attempts + 1,
        maxAttempts: row.max_attempts,
      };
    });
  }

  heartbeat(jobId: string, leaseMs = 60_000): void {
    this.db
      .prepare("UPDATE jobs SET locked_until=?, updated_at=? WHERE id=? AND locked_by=?")
      .run(
        new Date(Date.now() + leaseMs).toISOString(),
        new Date().toISOString(),
        jobId,
        this.workerId,
      );
  }

  complete(jobId: string): void {
    this.db
      .prepare(
        "UPDATE jobs SET state='done', locked_by=NULL, locked_until=NULL, updated_at=? WHERE id=?",
      )
      .run(new Date().toISOString(), jobId);
  }

  /** Exhausted attempts fail permanently; otherwise back off exponentially and retry. */
  fail(jobId: string, error: string, retryDelayMs?: number): void {
    const now = new Date();
    const row = this.db
      .prepare("SELECT attempts, max_attempts FROM jobs WHERE id=?")
      .get<{ attempts: number; max_attempts: number }>(jobId);
    if (!row) return;

    if (row.attempts >= row.max_attempts) {
      this.db
        .prepare(
          "UPDATE jobs SET state='failed', last_error=?, locked_by=NULL, locked_until=NULL, updated_at=? WHERE id=?",
        )
        .run(error, now.toISOString(), jobId);
      return;
    }
    const delay = retryDelayMs ?? Math.min(2 ** row.attempts * 1000, 300_000);
    this.db
      .prepare(
        `UPDATE jobs SET state='queued', last_error=?, locked_by=NULL, locked_until=NULL,
                         run_after=?, updated_at=? WHERE id=?`,
      )
      .run(error, new Date(now.getTime() + delay).toISOString(), now.toISOString(), jobId);
  }

  stats(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT state, COUNT(*) as n FROM jobs GROUP BY state")
      .all<{ state: string; n: number }>();
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }
}
