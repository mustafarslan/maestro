import { randomUUID } from "node:crypto";

/**
 * Prefixed ids: readable in logs and self-describing in a PR comment or trace view.
 * `rv_1a2b…` beats a bare uuid when you are staring at a waterfall.
 */
export type IdPrefix = "rv" | "tk" | "env" | "fd" | "pb" | "pv" | "sp" | "job" | "call";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}
