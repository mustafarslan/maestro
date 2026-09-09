import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SEVERITIES } from "./finding.js";

/**
 * Guards against the ordering being written out a seventh time.
 *
 * Collapsing the copies is the fix; this stops them coming back. A file that spells the
 * list in a different order is the specific failure — it compiles, it reads as correct,
 * and it inverts a comparison somewhere far away.
 */
const root = join(import.meta.dirname, "../../..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

describe("one severity ordering", () => {
  it("is spelled in the same order everywhere it is still written out", () => {
    // These two are zod enums that cannot import from agents without a dependency cycle,
    // so they restate the list and must restate it identically.
    //
    // The first version of this test asserted `toContain(SEVERITIES.join(...))`, which is
    // a whole-file substring search: it could not see the ORDER as written, and it
    // skipped any file not mentioning "critical" rather than failing. A guard that
    // passes vacuously is worse than no guard, and Maestro caught this one on the commit
    // that introduced it.
    for (const file of ["packages/playbook/src/schema.ts", "packages/mcp/src/server.ts"]) {
      const text = read(file);
      const literals = [...text.matchAll(/"(critical|high|medium|low|info)"/g)].map((m) => m[1]);
      expect(literals.length, `${file} no longer states the severity list at all`).toBeGreaterThan(
        0,
      );

      // Every run of five consecutive severity literals must be the canonical order.
      for (let i = 0; i + SEVERITIES.length <= literals.length; i++) {
        const window = literals.slice(i, i + SEVERITIES.length);
        if (new Set(window).size !== SEVERITIES.length) continue;
        expect(window, `${file} spells the severity list in a different order`).toEqual([
          ...SEVERITIES,
        ]);
      }
    }
  });

  it("has no rank map left to drift", () => {
    // Three of these existed. A fourth appearing is the bug returning.
    for (const file of [
      "packages/engine/src/triage.ts",
      "packages/engine/src/engine.ts",
      "packages/engine/src/eval.ts",
      "packages/mcp/src/server.ts",
    ]) {
      expect(read(file), `${file} defines its own severity rank map`).not.toMatch(
        /critical:\s*0,\s*high:\s*1/,
      );
    }
  });
});
