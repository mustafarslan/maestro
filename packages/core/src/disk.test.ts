import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { checkDisk, diskSpace, MIN_FREE_BYTES } from "./disk.js";

/**
 * Phase 7 asks for "backpressure when Docker, disk or budget saturates". The budget half
 * refuses a review before the job exists; the disk half did not exist at all — which is
 * the one that matters most for a system whose job is creating containers and snapshot
 * images. When the disk fills, `docker commit` fails, dependency installs fail and SQLite
 * writes fail, each looking like a different problem and none of them saying "no space".
 */
describe("free space where reviews are prepared", () => {
  it("reads a real filesystem", () => {
    const space = diskSpace(tmpdir());
    expect(space).not.toBeNull();
    expect(space?.totalBytes).toBeGreaterThan(0);
    expect(space?.freeRatio).toBeGreaterThanOrEqual(0);
    expect(space?.freeRatio).toBeLessThanOrEqual(1);
  });

  it("passes on a machine with room", () => {
    // Only meaningful because the floors are stated: this asserts the check does not
    // simply always refuse.
    expect(checkDisk(tmpdir(), { minFreeBytes: 1, minFreeRatio: 0 }).ok).toBe(true);
  });

  it("refuses below the byte floor, and says how much is left", () => {
    const verdict = checkDisk(tmpdir(), { minFreeBytes: Number.MAX_SAFE_INTEGER });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/free on the volume holding/);
    expect(verdict.reason).toMatch(/floor/);
  });

  it("refuses below the proportional floor even when the byte floor passes", () => {
    // A large disk can hold gigabytes and still be nearly full. The two floors answer
    // different questions and either one is enough to stop.
    const verdict = checkDisk(tmpdir(), { minFreeBytes: 1, minFreeRatio: 1.1 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/%/);
  });

  it("carries on when the filesystem will not answer", () => {
    // Refusing every review because a filesystem is unusual would be worse than the
    // problem this guards against, so an unreadable path is not a stop.
    const verdict = checkDisk("/definitely/not/a/path/anywhere");
    expect(verdict.ok).toBe(true);
    expect(verdict.space).toBeNull();
  });

  it("states a floor a review can actually fit in", () => {
    // One review clones a repository, installs its dependencies and commits a snapshot
    // image. A floor of a few hundred megabytes would let it start and then fail.
    expect(MIN_FREE_BYTES).toBeGreaterThanOrEqual(1024 ** 3);
  });
});
