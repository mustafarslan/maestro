import { describe, expect, it } from "vitest";
import { dockerCommand } from "./docker.js";

/**
 * What happens to a docker command when the review is cancelled.
 *
 * Cancel-on-push exists so a superseded review stops holding containers. Two things stood
 * between it and that: an already-aborted signal never fires its listener, so every
 * command started after the cancellation ran to completion; and an aborted command
 * reported the timeout exit code, so everything downstream was told the repository's build
 * had hung when in fact somebody had pushed.
 *
 * These use `docker version`, which is cheap and starts no container.
 */
describe("a cancelled docker command", () => {
  it("does not start at all when the signal has already aborted", async () => {
    // The important one. `addEventListener("abort")` on a signal that has already aborted
    // never fires — confirmed against Node — so this could only ever be caught by checking
    // `aborted` up front, and until it was, cancellation released nothing.
    const controller = new AbortController();
    controller.abort();

    const started = Date.now();
    const res = await dockerCommand(["version"], { signal: controller.signal });

    expect(res.aborted).toBe(true);
    expect(res.exitCode).toBe(130);
    expect(res.stderr).toContain("cancelled");
    // It must not have run: a real `docker version` is not instantaneous.
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("is not reported as a timeout", async () => {
    // 124 is the timeout convention; 130 is "terminated". A cancelled command reported
    // 124, so a review cancelled by a push looked like a hung build to the agent, to the
    // metrics block and to whoever read the comment.
    const controller = new AbortController();
    controller.abort();
    const res = await dockerCommand(["version"], { signal: controller.signal });

    expect(res.timedOut).toBe(false);
    expect(res.exitCode).not.toBe(124);
  });

  it("runs normally when nothing has cancelled it", async () => {
    const res = await dockerCommand(["version", "--format", "{{.Client.Version}}"], {
      signal: new AbortController().signal,
      timeoutMs: 20_000,
    });
    expect(res.aborted).toBeFalsy();
    expect(res.exitCode).toBe(0);
  });
});
