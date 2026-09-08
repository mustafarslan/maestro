import { logger } from "../logger.js";
import type { SqlDatabase } from "./driver.js";
import { migrations } from "./migrations/index.js";

const TRACKING_TABLE = /* sql */ `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);`;

export interface MigrationState {
  current: number;
  latest: number;
  pending: number[];
}

export function migrationState(db: SqlDatabase): MigrationState {
  db.exec(TRACKING_TABLE);
  const applied = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all<{ version: number }>()
    .map((r) => r.version);
  const latest = migrations.reduce((max, m) => Math.max(max, m.version), 0);
  return {
    current: applied.length ? Math.max(...applied) : 0,
    latest,
    pending: migrations.filter((m) => !applied.includes(m.version)).map((m) => m.version),
  };
}

/** Each migration runs in its own transaction: a failure leaves earlier ones applied and
 *  the tracking table honest, rather than silently half-migrating. */
export function migrate(db: SqlDatabase): MigrationState {
  db.exec(TRACKING_TABLE);
  const applied = new Set(
    db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all<{ version: number }>()
      .map((r) => r.version),
  );

  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
    });
    logger.info({ version: m.version, name: m.name }, "migration applied");
  }
  return migrationState(db);
}
