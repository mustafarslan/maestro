import { up as m001 } from "./001_init.js";
import { up as m002 } from "./002_trajectories.js";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Migrations are embedded strings, not .sql files on disk: the compiled binary has
 * no directory to read them from.
 */
export const migrations: Migration[] = [
  { version: 1, name: "init", sql: m001 },
  { version: 2, name: "trajectories", sql: m002 },
];
