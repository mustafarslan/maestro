import { describe, expect, it } from "vitest";
import {
  ACTIVE_TASK_STATES,
  ENVIRONMENT_STATES,
  LIVE_ENVIRONMENT_STATES,
  TASK_STATES,
} from "./lifecycle.js";

/**
 * The schema's comments describe richer lifecycles than the code enacts. These pin what is
 * real, so a state that starts being written — or stops — has to be reflected here rather
 * than quietly diverging from the SQL that filters on it.
 */
describe("environment states", () => {
  it("lists only what the recorder ever writes", () => {
    // The schema comment names six. Three of them — creating, ready, destroying — are
    // written by nothing, and the admin UI used to keep a hand-written set enumerating
    // exactly those three.
    expect([...ENVIRONMENT_STATES]).toEqual(["running", "destroyed", "leaked"]);
  });

  it("treats only a running environment as still holding a container", () => {
    expect([...LIVE_ENVIRONMENT_STATES]).toEqual(["running"]);
  });

  it("counts a leaked environment as not live, since its review is over", () => {
    // Leaked means teardown failed: the container may well still exist, but no review is
    // using it and `maestro reap` is what collects it.
    expect(LIVE_ENVIRONMENT_STATES).not.toContain("leaked");
  });
});

describe("task states", () => {
  it("lists only what the engine ever writes", () => {
    expect([...TASK_STATES]).toEqual(["running", "done", "failed", "skipped"]);
  });

  it("treats only a running task as strandable by a crash", () => {
    // `recoverStaleReviews` filtered on `('pending','ready','running')`, and nothing has
    // ever written the first two — so two-thirds of that condition could never match.
    expect([...ACTIVE_TASK_STATES]).toEqual(["running"]);
  });

  it("does not try to recover a task that already finished", () => {
    for (const done of ["done", "failed", "skipped"]) {
      expect(ACTIVE_TASK_STATES).not.toContain(done);
    }
  });
});
