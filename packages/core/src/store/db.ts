import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { dbPath } from "../paths.js";
import { openDatabase, type SqlDatabase } from "./driver.js";
import { migrate } from "./migrate.js";

export interface OpenOptions {
  path?: string;
  /** Skip migrations when a caller only wants to inspect state (e.g. `doctor`). */
  migrate?: boolean;
}

export async function openStore(opts: OpenOptions = {}): Promise<SqlDatabase> {
  const path = opts.path ?? dbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = await openDatabase(path);
  if (opts.migrate !== false) migrate(db);
  return db;
}
