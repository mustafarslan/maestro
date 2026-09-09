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
