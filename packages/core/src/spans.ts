import { newId } from "./ids.js";
import type { SqlDatabase } from "./store/driver.js";

/**
 * OTel-shaped spans persisted to the store. The admin UI's waterfall reads these
 * directly, which is why v1 needs no Grafana/Tempo; an OTLP exporter can consume
 * the same rows later.
 */
export interface SpanContext {
  reviewId?: string;
  taskId?: string;
  parentId?: string;
}

export class SpanRecorder {
  constructor(private readonly db: SqlDatabase) {}

  start(name: string, ctx: SpanContext = {}, attrs?: Record<string, unknown>): string {
    const id = newId("sp");
    this.db
      .prepare(
        `INSERT INTO spans (id, review_id, task_id, parent_id, name, status, attrs_json, started_at)
         VALUES (?, ?, ?, ?, ?, 'ok', ?, ?)`,
      )
      .run(
        id,
        ctx.reviewId ?? null,
        ctx.taskId ?? null,
        ctx.parentId ?? null,
        name,
        attrs ? JSON.stringify(attrs) : null,
        new Date().toISOString(),
      );
    return id;
  }

  end(spanId: string, status: "ok" | "error" = "ok", attrs?: Record<string, unknown>): void {
    const row = this.db
      .prepare("SELECT started_at, attrs_json FROM spans WHERE id=?")
      .get<{ started_at: string; attrs_json: string | null }>(spanId);
    if (!row) return;
    const endedAt = new Date();
    const merged = attrs
      ? { ...(row.attrs_json ? JSON.parse(row.attrs_json) : {}), ...attrs }
      : row.attrs_json
        ? JSON.parse(row.attrs_json)
        : null;
    this.db
      .prepare("UPDATE spans SET status=?, ended_at=?, duration_ms=?, attrs_json=? WHERE id=?")
      .run(
        status,
        endedAt.toISOString(),
        endedAt.getTime() - new Date(row.started_at).getTime(),
        merged ? JSON.stringify(merged) : null,
        spanId,
      );
  }

  /** Wraps a unit of work so the span is closed on both paths — including throws. */
  async span<T>(
    name: string,
    ctx: SpanContext,
    fn: (spanId: string) => Promise<T>,
    attrs?: Record<string, unknown>,
  ): Promise<T> {
    const id = this.start(name, ctx, attrs);
    try {
      const out = await fn(id);
      this.end(id, "ok");
      return out;
    } catch (err) {
      this.end(id, "error", { error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }
}
