import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dependencyCacheKey, mayWriteCache, snapshotTag } from "./cache.js";
import { detectToolchain } from "./toolchain.js";

let dir: string;
const toolchain = detectToolchain({ files: ["package.json"], read: () => undefined });

const input = (over: Partial<Parameters<typeof dependencyCacheKey>[0]> = {}) => ({
  sourcePath: dir,
  image: "node:22-bookworm",
  setup: ["npm ci --ignore-scripts"],
  toolchain,
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "maestro-cache-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("dependency cache key", () => {
  it("is stable when nothing changes", () => {
    writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3}');
    expect(dependencyCacheKey(input())).toBe(dependencyCacheKey(input()));
  });

  it("changes when the lockfile changes", () => {
    writeFileSync(join(dir, "package-lock.json"), '{"a":1}');
    const before = dependencyCacheKey(input());
    writeFileSync(join(dir, "package-lock.json"), '{"a":2}');
    expect(dependencyCacheKey(input())).not.toBe(before);
  });

  it("changes when the base image changes", () => {
    // A different image is a genuinely different environment; reusing the old layer
    // would make the review irreproducible.
    writeFileSync(join(dir, "package-lock.json"), "{}");
    expect(dependencyCacheKey(input({ image: "node:20-bookworm" }))).not.toBe(
      dependencyCacheKey(input()),
    );
  });

  it("changes when the setup commands change", () => {
    writeFileSync(join(dir, "package-lock.json"), "{}");
    expect(dependencyCacheKey(input({ setup: ["npm ci"] }))).not.toBe(dependencyCacheKey(input()));
  });

  it("refuses to key a repo with no lockfile", () => {
    // Without a lockfile there is no reproducible dependency set, so nothing is safe
    // to reuse and a full install is the only correct answer.
    expect(dependencyCacheKey(input())).toBeNull();
  });

  it("produces a docker-safe tag", () => {
    writeFileSync(join(dir, "package-lock.json"), "{}");
    const tag = snapshotTag(dependencyCacheKey(input()) as string);
    expect(tag).toMatch(/^maestro\/deps:[0-9a-f]{32}$/);
  });
});

describe("cache write policy", () => {
  it("lets a trusted pull request populate the cache", () => {
    expect(mayWriteCache("trusted")).toBe(true);
  });

  it("never lets an untrusted fork write the cache", () => {
    // Read-only for forks: one hostile fork would otherwise poison the dependency
    // layer for every later review of the repository.
    expect(mayWriteCache("untrusted")).toBe(false);
  });
});
