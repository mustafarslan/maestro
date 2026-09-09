import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Toolchain } from "./toolchain.js";

/**
 * Dependency snapshot reuse.
 *
 * Installing dependencies dominates a review's wall clock. When the lockfile has not
 * changed, reinstalling produces the same tree, so the previous dependency layer can be
 * reused and the prepare phase drops to near zero.
 *
 * The key deliberately covers the base image and the setup commands as well as the
 * lockfile: changing either produces a genuinely different environment, and silently
 * reusing a stale one would make reviews irreproducible.
 */

const LOCKFILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "uv.lock",
  "poetry.lock",
  "requirements.txt",
  "go.sum",
  "Cargo.lock",
];

export interface CacheKeyInput {
  sourcePath: string;
  image: string;
  setup: string[];
  toolchain: Toolchain;
}

/** Returns null when there is no lockfile, since then no reuse is provably safe. */
export function dependencyCacheKey(input: CacheKeyInput): string | null {
  const hash = createHash("sha256");
  let found = false;

  for (const name of LOCKFILES) {
    const path = join(input.sourcePath, name);
    if (!existsSync(path)) continue;
    found = true;
    hash.update(name);
    hash.update(readFileSync(path));
  }
  if (!found) return null;

  hash.update(input.image);
  hash.update(input.setup.join(" "));
  hash.update(input.toolchain.kind);
  return hash.digest("hex").slice(0, 32);
}

export function snapshotTag(cacheKey: string): string {
  return `maestro/deps:${cacheKey}`;
}

/**
 * Untrusted (fork) pull requests may READ a cached layer but must never write one:
 * otherwise a single hostile fork poisons the cache for every later review of that repo.
 */
export function mayWriteCache(trust: string): boolean {
  return trust !== "untrusted";
}
