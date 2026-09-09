import { statfsSync } from "node:fs";

/**
 * Free space where Maestro works.
 *
 * Phase 7 asks for "backpressure when Docker, disk or budget saturates". Budget was
 * built; disk was not, and it is the one that matters most for a system whose entire job
 * is creating containers and snapshot images. When the disk fills, nothing says so:
 * `docker commit` fails, dependency installs fail, SQLite writes fail, and every review
 * fails for a different-looking reason.
 *
 * `statfsSync` is used rather than shelling out to `df`, both because it is one call and
 * because it behaves identically under `node:fs` and Bun's implementation of it — which
 * the compiled binary depends on and a `df` parser would not have guaranteed.
 */
export interface DiskSpace {
  freeBytes: number;
  totalBytes: number;
  /** 0..1. A ratio matters on a small disk where a fixed floor is most of it. */
  freeRatio: number;
}

/**
 * Null when the platform will not answer, which is a reason to carry on rather than to
 * stop: refusing every review because a filesystem is unusual would be worse than the
 * problem this guards against.
 */
export function diskSpace(path: string): DiskSpace | null {
  try {
    const s = statfsSync(path);
    const freeBytes = Number(s.bsize) * Number(s.bavail);
    const totalBytes = Number(s.bsize) * Number(s.blocks);
    if (!totalBytes) return null;
    return { freeBytes, totalBytes, freeRatio: freeBytes / totalBytes };
  } catch {
    return null;
  }
}

/**
 * The floor. A review clones a repository, installs its dependencies and commits a
 * snapshot image; a few gigabytes is the honest cost of one, and several run at once.
 */
export const MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024;

/** And a proportional floor, for a disk small enough that 5GiB is most of it. */
export const MIN_FREE_RATIO = 0.05;

export interface DiskVerdict {
  ok: boolean;
  reason?: string;
  space: DiskSpace | null;
}

export function checkDisk(
  path: string,
  opts: { minFreeBytes?: number; minFreeRatio?: number } = {},
): DiskVerdict {
  const space = diskSpace(path);
  if (!space) return { ok: true, space: null };

  const minFreeBytes = opts.minFreeBytes ?? MIN_FREE_BYTES;
  const minFreeRatio = opts.minFreeRatio ?? MIN_FREE_RATIO;
  const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)}GiB`;

  // Either floor is enough to stop. They answer different questions — "is there room for
  // one review" and "is this filesystem about to be a problem for everything else on it".
  if (space.freeBytes < minFreeBytes) {
    return {
      ok: false,
      reason: `${gb(space.freeBytes)} free on the volume holding ${path}, below the ${gb(minFreeBytes)} floor`,
      space,
    };
  }
  if (space.freeRatio < minFreeRatio) {
    return {
      ok: false,
      reason: `${(space.freeRatio * 100).toFixed(1)}% free on the volume holding ${path}, below the ${(minFreeRatio * 100).toFixed(0)}% floor`,
      space,
    };
  }
  return { ok: true, space };
}
