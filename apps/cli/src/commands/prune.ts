import { statSync } from "node:fs";
import { dbPath, openStore, pruneTelemetry } from "@maestro/core";
import { numberArg } from "../args.js";
import { checkLine, color } from "../ui.js";

/**
 * Deletes the per-step trace of old reviews.
 *
 * Explicit, never automatic. Nothing in this system had ever deleted anything, and the
 * right first version of retention is a command somebody runs on purpose rather than a
 * timer that removes their history while they are not looking.
 *
 * Narrow by design: reviews, findings and feedback stay for ever — they are the quality
 * history and they are small — and `jobs` stays because its dedupe key is the idempotency
 * record. What goes is `spans` and `llm_calls`, one row per model step, which is the bulk
 * and the part nobody reads once the question has been answered.
 */
export async function prune(argv: string[]): Promise<number> {
  const days = numberArg(argv, "--days", { fallback: 30, min: 1 }) ?? 30;
  const db = await openStore();
  try {
    const before = sizeOf(dbPath());
    const { spans, llmCalls } = pruneTelemetry(db, days * 24 * 60 * 60_000);

    console.log(color.bold("\nmaestro prune\n"));
    console.log(
      checkLine(
        spans + llmCalls > 0 ? "ok" : "info",
        "removed",
        `${spans} span(s) and ${llmCalls} model call(s) from reviews finished more than ${days} days ago`,
      ),
    );
    console.log(
      checkLine("info", "kept", "reviews, findings and feedback — the quality history is small"),
    );
    // The file does not shrink until VACUUM, and saying "removed N rows" beside an
    // unchanged file size would look like nothing happened.
    if (before !== undefined) {
      console.log(
        checkLine(
          "info",
          "database",
          `${before} — SQLite reuses freed pages rather than shrinking; run 'sqlite3 ${dbPath()} VACUUM' to reclaim`,
        ),
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

function sizeOf(path: string): string | undefined {
  try {
    return `${(statSync(path).size / 1e6).toFixed(1)} MB`;
  } catch {
    return undefined;
  }
}
