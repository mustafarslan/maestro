import { EnvSpecSchema } from "@maestro/playbook";
import { describe, expect, it } from "vitest";
import { runComparisons } from "./compare.js";
import type { ExecResult, PreparedEnvironment, Sandbox, SandboxDriver } from "./types.js";

const spec = EnvSpecSchema.parse({ compareCommands: ["npm test"] });

function env(id: string): PreparedEnvironment {
  return {
    id,
    reviewId: "rv_1",
    imageId: `img_${id}`,
    toolchain: { kind: "node", image: "node:22-bookworm", setup: [], commands: {} },
    allowedCommands: [],
    setupResults: [],
    egressLog: [],
  };
}

/**
 * A driver whose two environments answer differently, so a test can state "this command
 * fails at the base and passes at the head" as a fact about the fixture rather than
 * hoping a container produces it.
 */
function fakeDriver(
  answers: Record<string, Record<string, Partial<ExecResult>>>,
  files: Record<string, string> = {},
): SandboxDriver {
  return {
    name: "fake",
    available: async () => true,
    prepare: async () => env("prepared"),
    analyze: async (e): Promise<Sandbox> => ({
      id: e.id,
      containerId: `c_${e.id}`,
      exec: async (command: string): Promise<ExecResult> => ({
        command,
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 5,
        timedOut: false,
        ...(answers[e.id]?.[command] ?? {}),
      }),
      readFile: async (path: string) => {
        const content = files[`${e.id}:${path}`];
        if (content === undefined) throw new Error("no such file");
        return content;
      },
      destroy: async () => {},
    }),
    reap: async () => ({ containers: 0, images: 0, networks: 0 }),
  };
}

describe("base versus head comparison", () => {
  it("reports a test that fails at the base and passes at the head", async () => {
    const driver = fakeDriver({
      base: { "npm test": { exitCode: 1, stdout: "1 failing" } },
      head: { "npm test": { exitCode: 0, stdout: "0 failing" } },
    });

    const [result] = await runComparisons(
      { headEnv: env("head"), baseEnv: env("base"), commands: ["npm test"], spec },
      { driver },
    );

    expect(result?.verdict).toBe("fixed");
    expect(result?.base?.exitCode).toBe(1);
    expect(result?.head?.exitCode).toBe(0);
    expect(result?.skipped).toBeUndefined();
  });

  it("reports the reverse just as plainly", async () => {
    const driver = fakeDriver({
      base: { "npm test": { exitCode: 0 } },
      head: { "npm test": { exitCode: 1 } },
    });
    const [result] = await runComparisons(
      { headEnv: env("head"), baseEnv: env("base"), commands: ["npm test"], spec },
      { driver },
    );
    expect(result?.verdict).toBe("broken");
  });

  it("does not turn a timing difference into a verdict", async () => {
    // The single most dangerous thing this feature could do is announce a speedup from
    // two numbers measured on a shared host. Same exit code, ten times the duration, and
    // the verdict must still be that nothing about the outcome changed.
    const driver = fakeDriver({
      base: { "npm test": { exitCode: 0, durationMs: 10_000 } },
      head: { "npm test": { exitCode: 0, durationMs: 1_000 } },
    });
    const [result] = await runComparisons(
      { headEnv: env("head"), baseEnv: env("base"), commands: ["npm test"], spec },
      { driver },
    );
    expect(result?.verdict).toBe("same-exit");
  });

  it("does not turn an output difference into a verdict either", async () => {
    // Test runners print timestamps and durations, so two identical runs differ byte for
    // byte. A normalisation rule that is subtly wrong yields a confident wrong verdict,
    // which is worse than having none: the output is shown, and the agent judges it.
    const driver = fakeDriver({
      base: { "npm test": { exitCode: 0, stdout: "ok in 1.20s" } },
      head: { "npm test": { exitCode: 0, stdout: "ok in 1.31s" } },
    });
    const [result] = await runComparisons(
      { headEnv: env("head"), baseEnv: env("base"), commands: ["npm test"], spec },
      { driver },
    );
    expect(result?.verdict).toBe("same-exit");
    expect(result?.base?.stdoutTail).toBe("ok in 1.20s");
    expect(result?.head?.stdoutTail).toBe("ok in 1.31s");
  });

  it("says a command new in this pull request was not runnable, not that it failed", async () => {
    // By exit code alone "missing script" and "the test failed" are both non-zero, and
    // calling the first one a base-side failure would manufacture a `fixed` verdict for
    // a command that never ran there.
    const driver = fakeDriver(
      {
        base: { "npm run bench": { exitCode: 1, stderr: "Missing script: bench" } },
        head: { "npm run bench": { exitCode: 0 } },
      },
      {
        "base:package.json": JSON.stringify({ scripts: { test: "vitest" } }),
        "head:package.json": JSON.stringify({ scripts: { test: "vitest", bench: "vitest bench" } }),
      },
    );
    const [result] = await runComparisons(
      { headEnv: env("head"), baseEnv: env("base"), commands: ["npm run bench"], spec },
      { driver },
    );
    expect(result?.skipped).toBe("not-runnable");
    expect(result?.verdict).toBe("not-comparable");
    expect(result?.base).toBeNull();
  });

  it("still compares a script that exists on both sides", async () => {
    const driver = fakeDriver(
      {
        base: { "npm test": { exitCode: 1 } },
        head: { "npm test": { exitCode: 0 } },
      },
      {
        "base:package.json": JSON.stringify({ scripts: { test: "vitest" } }),
        "head:package.json": JSON.stringify({ scripts: { test: "vitest" } }),
      },
    );
    const [result] = await runComparisons(
      { headEnv: env("head"), baseEnv: env("base"), commands: ["npm test"], spec },
      { driver },
    );
    expect(result?.skipped).toBeUndefined();
    expect(result?.verdict).toBe("fixed");
  });

  it("reports a missing baseline as skipped rather than as an empty comparison", async () => {
    // A silently empty result reads as "we checked and there was nothing", which is a
    // much stronger claim than "we could not check".
    const driver = fakeDriver({});
    const results = await runComparisons(
      {
        headEnv: env("head"),
        baseEnv: null,
        commands: ["npm test"],
        spec,
        baseUnavailable: "no-merge-base",
      },
      { driver },
    );
    expect(results[0]?.skipped).toBe("no-merge-base");
    expect(results[0]?.verdict).toBe("not-comparable");
  });

  it("records both sides' sample count equally when it repeats", async () => {
    // Judging repeatability per side would give a genuine speedup three head samples
    // against one base sample, which compares nothing.
    const driver = fakeDriver({
      base: { "npm test": { exitCode: 0, durationMs: 100 } },
      head: { "npm test": { exitCode: 0, durationMs: 50 } },
    });
    const [result] = await runComparisons(
      { headEnv: env("head"), baseEnv: env("base"), commands: ["npm test"], spec },
      { driver },
    );
    expect(result?.base?.durationsMs.length).toBe(result?.head?.durationsMs.length);
    expect(result?.base?.durationsMs.length).toBeGreaterThan(1);
  });

  it("takes a single sample when the command is too slow to repeat cheaply", async () => {
    const driver = fakeDriver({
      base: { "npm test": { exitCode: 0, durationMs: 45_000 } },
      head: { "npm test": { exitCode: 0, durationMs: 44_000 } },
    });
    const [result] = await runComparisons(
      { headEnv: env("head"), baseEnv: env("base"), commands: ["npm test"], spec },
      { driver },
    );
    expect(result?.base?.durationsMs).toHaveLength(1);
    expect(result?.head?.durationsMs).toHaveLength(1);
  });

  it("records the concurrent load at each run rather than once per comparison", async () => {
    let calls = 0;
    const driver = fakeDriver({
      base: { "npm test": { exitCode: 0, durationMs: 45_000 } },
      head: { "npm test": { exitCode: 0, durationMs: 45_000 } },
    });
    const [result] = await runComparisons(
      { headEnv: env("head"), baseEnv: env("base"), commands: ["npm test"], spec },
      { driver, sampleLoad: () => ++calls },
    );
    // Base and head are measured seconds apart and a review can start in between, so one
    // sample for the pair would attribute the wrong load to one of them.
    expect(result?.base?.concurrentAgents).not.toBe(result?.head?.concurrentAgents);
  });

  it("destroys both containers even when a command throws", async () => {
    const destroyed: string[] = [];
    const driver: SandboxDriver = {
      ...fakeDriver({}),
      analyze: async (e) => ({
        id: e.id,
        containerId: `c_${e.id}`,
        exec: async () => {
          throw new Error("docker died");
        },
        readFile: async () => {
          throw new Error("no");
        },
        destroy: async () => {
          destroyed.push(e.id);
        },
      }),
    };
    const results = await runComparisons(
      { headEnv: env("head"), baseEnv: env("base"), commands: ["npm test"], spec },
      { driver },
    );
    // A failed comparison must cost the review its evidence, never its findings.
    expect(results[0]?.skipped).toBe("base-prepare-failed");
    expect(destroyed.sort()).toEqual(["base", "head"]);
  });

  it("does nothing at all when no commands are configured", async () => {
    const driver = fakeDriver({});
    expect(
      await runComparisons(
        { headEnv: env("head"), baseEnv: env("base"), commands: [], spec },
        { driver },
      ),
    ).toEqual([]);
  });
});
