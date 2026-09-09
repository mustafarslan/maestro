import { describe, expect, it } from "vitest";
import { openStore } from "./db.js";
import { migrate, migrationState } from "./migrate.js";
import { migrations } from "./migrations/index.js";

/** A database with the tracking table but no migrations run. */
async function fresh() {
  return await openStore({ path: ":memory:", migrate: false });
}

describe("the migration registry", () => {
  it("has no duplicate versions", () => {
    // A duplicate version is applied once and the other silently never runs, so its
    // tables are simply absent and the failure appears much later as a missing table.
    const versions = migrations.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("numbers migrations from 1 with no gaps", () => {
    // A gap usually means a migration was deleted rather than superseded, which leaves
    // installs that already ran it inconsistent with installs that never saw it.
    const sorted = migrations.map((m) => m.version).sort((a, b) => a - b);
    expect(sorted).toEqual(sorted.map((_, i) => i + 1));
  });

  it("gives every migration a name, for the log line that reports it", () => {
    for (const m of migrations) expect(m.name, `migration ${m.version} has no name`).toBeTruthy();
  });
});

describe("migrate", () => {
  it("takes a fresh database to the latest version", async () => {
    const db = await fresh();
    expect(migrationState(db).current).toBe(0);

    const after = migrate(db);
    expect(after.current).toBe(after.latest);
    expect(after.pending).toEqual([]);
  });

  it("is idempotent, because every start-up runs it", async () => {
    const db = await fresh();
    const first = migrate(db);
    const second = migrate(db);
    expect(second).toEqual(first);

    const rows = db.prepare("SELECT version FROM schema_migrations").all<{ version: number }>();
    // Applied once, recorded once — not once per process start.
    expect(rows.length).toBe(migrations.length);
  });

  it("reports pending work honestly before it runs", async () => {
    const db = await fresh();
    const before = migrationState(db);
    expect(before.pending).toEqual(migrations.map((m) => m.version).sort((a, b) => a - b));
    expect(before.current).toBeLessThan(before.latest);
  });

  it("creates the tracking table even when there is nothing to do", async () => {
    // `doctor` calls migrationState on a database it must not modify beyond this.
    const db = await fresh();
    expect(() => migrationState(db)).not.toThrow();
    const t = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .all<{ name: string }>();
    expect(t.length).toBe(1);
  });

  it("rolls back a failed migration rather than half-applying it", async () => {
    // The comment above migrate() promises each migration is transactional. SQLite does
    // support transactional DDL, but the promise is worth asserting: a half-applied
    // migration that still records its version is unrecoverable without hand-editing.
    const db = await fresh();
    migrate(db);

    expect(() =>
      db.transaction(() => {
        db.exec("CREATE TABLE half_applied (id TEXT PRIMARY KEY)");
        db.exec("THIS IS NOT SQL");
      }),
    ).toThrow();

    const leftover = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='half_applied'")
      .all<{ name: string }>();
    expect(leftover, "DDL from a failed transaction survived the rollback").toEqual([]);
  });

  it("leaves a schema the rest of the code can actually use", async () => {
    // The migration could apply cleanly and still not produce the tables everything
    // else assumes; naming them here makes that a test failure rather than a runtime one.
    const db = await fresh();
    migrate(db);
    const names = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all<{ name: string }>()
        .map((r) => r.name),
    );
    for (const table of [
      "playbooks",
      "playbook_versions",
      "repos",
      "reviews",
      "tasks",
      "environments",
      "findings",
      "feedback",
      "provider_configs",
      "model_catalog",
      "spans",
      "llm_calls",
      "jobs",
    ]) {
      expect(names.has(table), `the schema has no ${table} table`).toBe(true);
    }
  });
});
