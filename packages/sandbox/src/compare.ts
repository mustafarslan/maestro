import type { EnvSpec } from "@maestro/playbook";
import type {
  CommandComparison,
  CommandRun,
  PreparedEnvironment,
  Sandbox,
  SandboxDriver,
} from "./types.js";

/**
 * Runs the same commands at the merge-base and at the head, so a pull request claiming
 * "faster", "smaller" or "fixes the failing test" can be checked rather than believed.
 *
 * Both sides run in ANALYZE containers — `--network none`, dropped capabilities, the same
 * cpu/memory/pids caps — off their own prepared snapshot. That is not an implementation
 * detail: these commands run the repository's code, which is the thing the two-phase
 * design exists to contain. Running the base half in a prepare-shaped container would
 * hand it proxied network and a writable rootfs, regressing the posture for half of every
 * comparison. Passing one `spec` to both also makes "identical resource limits" a
 * property of the code rather than a promise in a document.
 *
 * What this module will not do is turn two timings into a ratio. See `verdictFor`.
 */

/** Output kept per stream. Matches the agent tool cap, for the same reason. */
const TAIL_CHARS = 8000;

/**
 * Below this, a command is cheap enough to repeat and say something about variance.
 *
 * Applied to the SLOWER side, so both refs always get the same number of samples. Judging
 * each side separately would give a pull request that genuinely speeds something up three
 * head samples against one base sample, which is not a comparison of anything.
 */
const REPEATABLE_UNDER_MS = 30_000;
const REPEATS = 3;

function tail(text: string): string {
  return text.length <= TAIL_CHARS ? text : `...\n${text.slice(-TAIL_CHARS)}`;
}

export interface CompareRequest {
  headEnv: PreparedEnvironment;
  /** Absent when the merge-base could not be prepared; every command then skips. */
  baseEnv: PreparedEnvironment | null;
  commands: string[];
  spec: EnvSpec;
  /** Why there is no base environment, when there isn't one. */
  baseUnavailable?: CommandComparison["skipped"];
  signal?: AbortSignal;
}

export interface CompareDeps {
  driver: SandboxDriver;
  /**
   * Agent containers running elsewhere at this instant.
   *
   * Injected rather than imported: the scheduler lives in `@maestro/server`, which depends
   * on this package. Defaults to reporting nothing rather than to reporting zero, since
   * "no agents were running" and "nobody asked" are different claims.
   */
  sampleLoad?: () => number;
  log?: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
}

/**
 * Exit codes decide the verdict. Timing and output never do.
 *
 * `fixed` and `broken` are statements a reviewer can act on: the command's pass/fail
 * changed across the diff. `same-exit` covers "both passed" and "both failed" — which are
 * different facts, but neither is evidence for a comparative claim, and collapsing them
 * here keeps the renderer from implying otherwise.
 */
function verdictFor(
  base: CommandRun | null,
  head: CommandRun | null,
): CommandComparison["verdict"] {
  if (!base || !head) return "not-comparable";
  if (base.exitCode !== 0 && head.exitCode === 0) return "fixed";
  if (base.exitCode === 0 && head.exitCode !== 0) return "broken";
  return "same-exit";
}

/**
 * The npm script a command invokes, if it invokes one.
 *
 * Only used to tell "this script does not exist at the merge-base" from "this script
 * failed at the merge-base" — by exit code alone they are both non-zero, and calling a
 * script the pull request ADDS a base-side failure would be a fabricated result. Narrow
 * on purpose: there is no general "is this command defined" detector here, because
 * guessing wrong invents evidence, which is the one outcome worse than having none.
 */
function npmScriptName(command: string): string | null {
  const m = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/.exec(command.trim());
  if (!m) return null;
  const name = m[1] as string;
  // `npm install` and friends are not scripts, and `npm run test` and `npm test` both are.
  return ["install", "ci", "i", "add", "exec", "dlx", "x"].includes(name) ? null : name;
}

async function scriptsOf(box: Sandbox): Promise<Set<string> | null> {
  try {
    const raw = await box.readFile("package.json", 256_000);
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    return new Set(Object.keys(parsed.scripts ?? {}));
  } catch {
    // No package.json, or unreadable, or not JSON. All mean "cannot tell", and the
    // caller falls back to reporting the exit codes as measured.
    return null;
  }
}

async function runOnce(
  box: Sandbox,
  command: string,
  spec: EnvSpec,
  sampleLoad: () => number,
): Promise<CommandRun> {
  const load = sampleLoad();
  const res = await box.exec(command, { timeoutSec: spec.timeouts.commandSec });
  return {
    exitCode: res.exitCode,
    stdoutTail: tail(res.stdout),
    stderrTail: tail(res.stderr),
    durationsMs: [res.durationMs],
    timedOut: res.timedOut,
    concurrentAgents: load,
  };
}

/**
 * Runs every configured command at both refs and reports what happened.
 *
 * Never throws for a command's sake: a comparison that cannot be made is reported as one
 * that was not made. Losing the whole review because a benchmark script is missing would
 * be a poor trade for a feature whose entire purpose is extra evidence.
 */
export async function runComparisons(
  req: CompareRequest,
  deps: CompareDeps,
): Promise<CommandComparison[]> {
  const { commands, spec } = req;
  if (!commands.length) return [];

  const sampleLoad = deps.sampleLoad ?? (() => 0);

  if (!req.baseEnv) {
    return commands.map((command) => ({
      command,
      base: null,
      head: null,
      verdict: "not-comparable" as const,
      skipped: req.baseUnavailable ?? "base-prepare-failed",
    }));
  }

  let baseBox: Sandbox | undefined;
  let headBox: Sandbox | undefined;
  try {
    baseBox = await deps.driver.analyze(req.baseEnv, { spec });
    headBox = await deps.driver.analyze(req.headEnv, { spec });

    const baseScripts = await scriptsOf(baseBox);
    const headScripts = await scriptsOf(headBox);

    const results: CommandComparison[] = [];
    for (const command of commands) {
      if (req.signal?.aborted) break;

      // A script the pull request adds cannot be run at the merge-base, and saying so is
      // the honest report. Calling it a base-side failure would manufacture the very
      // "fixed" verdict this feature is supposed to earn.
      const script = npmScriptName(command);
      if (
        script &&
        baseScripts &&
        headScripts &&
        !baseScripts.has(script) &&
        headScripts.has(script)
      ) {
        const head = await runOnce(headBox, command, spec, sampleLoad);
        results.push({
          command,
          base: null,
          head,
          verdict: "not-comparable",
          skipped: "not-runnable",
        });
        continue;
      }

      const base = await runOnce(baseBox, command, spec, sampleLoad);
      const head = await runOnce(headBox, command, spec, sampleLoad);

      // Repeat only when repeating is cheap, and interleave the refs so a change in load
      // partway through lands on both rather than on one.
      const slowest = Math.max(base.durationsMs[0] as number, head.durationsMs[0] as number);
      if (slowest < REPEATABLE_UNDER_MS && !base.timedOut && !head.timedOut) {
        for (let i = 1; i < REPEATS; i++) {
          if (req.signal?.aborted) break;
          const b = await runOnce(baseBox, command, spec, sampleLoad);
          const h = await runOnce(headBox, command, spec, sampleLoad);
          base.durationsMs.push(b.durationsMs[0] as number);
          head.durationsMs.push(h.durationsMs[0] as number);
        }
      }

      results.push({ command, base, head, verdict: verdictFor(base, head) });
    }

    deps.log?.info({ commands: commands.length }, "base-versus-head comparison complete");
    return results;
  } catch (err) {
    // One failed comparison must not cost the review its findings.
    deps.log?.warn({ err: String(err) }, "base-versus-head comparison failed");
    return commands.map((command) => ({
      command,
      base: null,
      head: null,
      verdict: "not-comparable" as const,
      skipped: "base-prepare-failed" as const,
    }));
  } finally {
    await baseBox?.destroy();
    await headBox?.destroy();
  }
}
