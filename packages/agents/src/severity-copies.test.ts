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
  it("is spelled the same way everywhere it is still written out", () => {
    // These two are zod enums that cannot import from agents without a dependency cycle,
    // so they restate the list and must restate it identically.
    const forward = SEVERITIES.join('", "');
    for (const file of ["packages/playbook/src/schema.ts", "packages/mcp/src/server.ts"]) {
      const text = read(file);
      if (!text.includes('"critical"')) continue;
      expect(text, `${file} spells the severity list in a different order`).toContain(forward);
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
