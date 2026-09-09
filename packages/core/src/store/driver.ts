/**
 * Portable SQLite access.
 *
 * The compiled binary runs on Bun (`bun:sqlite`); the `npm i -g` path runs on Node
 * (`node:sqlite`). Both ship the driver *in the runtime*, which is the whole point:
 * a native addon like better-sqlite3 does not survive `bun build --compile`.
 *
 * The two APIs are close but not identical, so this module normalises them to one
 * interface and one parameter-binding discipline (positional only, primitives only).
 */

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParam = SqlValue | boolean | undefined | Date;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqlStatement {
  run(...params: SqlParam[]): RunResult;
  get<T = unknown>(...params: SqlParam[]): T | undefined;
  all<T = unknown>(...params: SqlParam[]): T[];
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  /** BEGIN IMMEDIATE … COMMIT/ROLLBACK. Immediate matters: it takes the write lock up
   *  front, which is exactly what a queue claim needs to avoid SQLITE_BUSY mid-transaction. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** node:sqlite rejects booleans/undefined/Date outright; bun coerces inconsistently. Normalise both. */
function normalise(params: SqlParam[]): SqlValue[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    return p;
  });
}

export type Runtime = "bun" | "node";

export function detectRuntime(): Runtime {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? "bun" : "node";
}

interface RawStatement {
  run(...p: SqlValue[]): RunResult;
  get(...p: SqlValue[]): unknown;
  all(...p: SqlValue[]): unknown[];
}
interface RawDatabase {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
}

function wrap(raw: RawDatabase): SqlDatabase {
  let depth = 0;
  const db: SqlDatabase = {
    exec: (sql) => raw.exec(sql),
    prepare(sql) {
      const stmt = raw.prepare(sql);
      return {
        run: (...p) => stmt.run(...normalise(p)),
        // `?? undefined` is not decoration. `node:sqlite` returns `undefined` when a
        // query matches no row and `bun:sqlite` returns `null` — the compiled binary runs
        // the second — so the declared `T | undefined` was false on the runtime the
        // product actually ships. Nothing compared to `undefined` today, but writing
        // `if (row === undefined)` is the natural thing to do given that signature, and it
        // would have passed every test and failed in the binary. Normalised here so the
        // type is true on both.
        get: <T>(...p: SqlParam[]) => (stmt.get(...normalise(p)) ?? undefined) as T | undefined,
        all: <T>(...p: SqlParam[]) => stmt.all(...normalise(p)) as T[],
      };
    },
    transaction<T>(fn: () => T): T {
      // Nested transactions become savepoints so callers can compose freely.
      if (depth > 0) {
        const name = `sp_${depth}`;
        depth++;
        raw.exec(`SAVEPOINT ${name}`);
        try {
          const out = fn();
          raw.exec(`RELEASE ${name}`);
          return out;
        } catch (err) {
          raw.exec(`ROLLBACK TO ${name}`);
          raw.exec(`RELEASE ${name}`);
          throw err;
        } finally {
          depth--;
        }
      }
      depth++;
      raw.exec("BEGIN IMMEDIATE");
      try {
        const out = fn();
        raw.exec("COMMIT");
        return out;
      } catch (err) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          // rollback of an already-aborted transaction is not itself an error worth masking
        }
        throw err;
      } finally {
        depth--;
      }
    },
    close: () => raw.close(),
  };
  return db;
}

/**
 * Opened via a computed specifier so neither bundler statically resolves the other
 * runtime's builtin (`bun build` would choke on node:sqlite and vice versa).
 */
export async function openDatabase(path: string): Promise<SqlDatabase> {
  const runtime = detectRuntime();
  let raw: RawDatabase;

  if (runtime === "bun") {
    const spec = "bun:sqlite";
    const { Database } = (await import(/* @vite-ignore */ spec)) as {
      Database: new (p: string, o?: unknown) => RawDatabase;
    };
    raw = new Database(path, { create: true });
  } else {
    const spec = "node:sqlite";
    const { DatabaseSync } = (await import(/* @vite-ignore */ spec)) as {
      DatabaseSync: new (p: string) => RawDatabase;
    };
    raw = new DatabaseSync(path);
  }

  // WAL is what makes concurrent readers (the UI polling) coexist with the writer (the daemon).
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec("PRAGMA busy_timeout = 5000");
  raw.exec("PRAGMA synchronous = NORMAL");
  return wrap(raw);
}
