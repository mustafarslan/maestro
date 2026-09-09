import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every flag a command reads must be one it also accepts.
 *
 * `rejectUnknownFlags` turns a typo into an error, which is the point — and turns a flag
 * somebody adds and forgets to declare into a command that refuses its own documented
 * option. That is the failure this project has repeated most: fixing one half of
 * something and leaving the other. So the two halves are checked against each other
 * rather than trusted to stay in step.
 *
 * Read from the source because there is nothing to call: the declaration is an argument
 * at the top of a function that then does real work.
 */
const dir = join(import.meta.dirname, "commands");

const commands = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.includes(".test."));

/** Flags the command reads: the helpers, plus a bare `argv.includes("--x")`. */
function flagsRead(source: string): Set<string> {
  const found = new Set<string>();
  for (const m of source.matchAll(/(?:arg|args|has|numberArg)\(\s*argv,\s*"(--[\w-]+)"/g)) {
    found.add(m[1] as string);
  }
  for (const m of source.matchAll(/argv\.includes\("(--[\w-]+)"\)/g)) found.add(m[1] as string);
  return found;
}

/** Flags the command declares to `rejectUnknownFlags`. */
function flagsDeclared(source: string): Set<string> | null {
  const m = source.match(/rejectUnknownFlags\(argv,\s*\[([\s\S]*?)\]\)/);
  if (!m) return null;
  return new Set([...(m[1] as string).matchAll(/"(--[\w-]+)"/g)].map((x) => x[1] as string));
}

describe("declared flags and read flags agree", () => {
  for (const file of commands) {
    const source = readFileSync(join(dir, file), "utf8");
    const declared = flagsDeclared(source);
    const read = flagsRead(source);
    if (!declared) {
      // A command with no flags of its own needs no declaration; one that reads flags
      // and declares none would reject every one of them.
      it(`${file} reads no flags, so it declares none`, () => {
        expect([...read]).toEqual([]);
      });
      continue;
    }
    it(`${file} accepts every flag it reads`, () => {
      // `--help` is accepted everywhere by `rejectUnknownFlags` itself.
      const missing = [...read].filter((f) => !declared.has(f) && f !== "--help");
      expect(missing, `${file} reads ${missing.join(", ")} but does not accept it`).toEqual([]);
    });
  }
});
