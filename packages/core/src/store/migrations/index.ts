import { up as m001 } from "./001_init.js";
import { up as m002 } from "./002_trajectories.js";
import { up as m003 } from "./003_comment_kind.js";
import { up as m004 } from "./004_refinement.js";
import { up as m005 } from "./005_developer_profiles.js";
import { up as m006 } from "./006_profile_activation.js";

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
  { version: 3, name: "comment-kind", sql: m003 },
  { version: 4, name: "refinement", sql: m004 },
  { version: 5, name: "developer-profiles", sql: m005 },
  { version: 6, name: "profile-activation", sql: m006 },
];
