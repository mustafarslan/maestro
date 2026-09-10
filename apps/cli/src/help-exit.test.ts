import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluate } from "./commands/evaluate.js";
import { githubApp } from "./commands/github-app.js";
import { llm } from "./commands/llm.js";
import { playbook } from "./commands/playbook.js";
import { reap } from "./commands/reap.js";

/**
 * Asking for help is not an error.
 *
 * `usage()` returned 1 unconditionally, and it is printed for two different reasons:
 * somebody asked, or somebody got the command wrong. So `maestro playbook --help && ...`
 * failed in a shell, and a CI step that probes a command with `--help` read the tool as
 * broken. `reap` returned 0 and the rest returned 1, so the spellings also disagreed with
 * each other — which is how this was noticed.
 */
describe("--help exits 0, a mistake exits 1", () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  const commands = { playbook, llm, evaluate, reap, githubApp };

  for (const [name, fn] of Object.entries(commands)) {
    it(`${name} --help`, async () => {
      expect(await fn(["--help"])).toBe(0);
    });
  }

  // `reap` takes no subcommands, so it has no wrong-subcommand case to check.
  for (const [name, fn] of Object.entries({ playbook, llm, evaluate, githubApp })) {
    it(`${name} with a subcommand that does not exist`, async () => {
      expect(await fn(["not-a-subcommand"])).toBe(1);
    });

    it(`${name} with no subcommand`, async () => {
      // Not the same as asking for help: the command is incomplete.
      expect(await fn([])).toBe(1);
    });
  }
});

describe("-h means help everywhere, including where it did not", () => {
  /**
   * `rejectUnknownFlags` lists `-h` among the options it accepts, so `-h` passed the
   * guard — while `reap` and `serve` tested only for `--help`. `maestro reap -h`
   * therefore ran the destructive sweep, and the error message had promised the flag was
   * understood. Confirmed by running it: it swept, and closed six environment rows.
   *
   * Reported by Maestro reviewing its own commit.
   */
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  it("reap -h prints help instead of sweeping", async () => {
    // `reap` reaches Docker if it does not return early, so this asserting 0 is also
    // asserting it never got there.
    expect(await reap(["-h"])).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("maestro reap");
  });

  for (const [name, fn] of Object.entries({ playbook, llm, evaluate, githubApp })) {
    it(`${name} -h`, async () => {
      expect(await fn(["-h"])).toBe(0);
    });
  }

  it("finds -h after a subcommand, not only as the first argument", async () => {
    // `maestro llm test -h` asks for help about `test`. The dispatchers only looked at
    // argv[0], so this ran the subcommand.
    expect(await llm(["test", "-h"])).toBe(0);
    expect(await playbook(["export", "--help"])).toBe(0);
  });
});
