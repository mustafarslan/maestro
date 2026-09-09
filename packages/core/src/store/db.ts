import { chmodSync, existsSync, mkdirSync } from "node:fs";
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
  if (path !== ":memory:") restrictPermissions(path);
  if (opts.migrate !== false) migrate(db);
  return db;
}

/**
 * Keeps the database readable only by its owner.
 *
 * SQLite creates the file with the process umask, which is 0644 on a normal system, so
 * `~/.maestro/maestro.db` was world-readable. It holds every review: pull request titles,
 * diff summaries, agent findings and provider configuration, all from private
 * repositories. On any shared host that is every local account's to read, from a tool
 * whose entire job is looking at code people did not publish.
 *
 * Done here rather than in `init` because the daemon, the CLI and the MCP server all
 * open the store directly, and a rule enforced in one entry point is a rule with holes.
 * `mkdirSync`'s mode argument only applies when it creates the directory, so a home that
 * already exists keeps whatever mode it had — hence the explicit chmod on both.
 */
function restrictPermissions(path: string): void {
  const attempts: [string, number][] = [
    [dirname(path), 0o700],
    [path, 0o600],
    // SQLite's write-ahead log and shared-memory files carry the same content.
    [`${path}-wal`, 0o600],
    [`${path}-shm`, 0o600],
  ];
  for (const [target, mode] of attempts) {
    try {
      if (existsSync(target)) chmodSync(target, mode);
    } catch {
      // A store on a filesystem without POSIX modes, or owned by someone else, is not a
      // reason to refuse to run; the alternative is a tool that will not start at all.
    }
  }
}
