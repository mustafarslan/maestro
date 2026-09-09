import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NODE_SPECS } from "./nodes.js";
import { AGENT_TOOLS, GraphNodeSchema } from "./schema.js";

/**
 * Lists that are written out more than once and must agree.
 *
 * Three separate defects today came from exactly this shape — the in-flight review
 * states, the UI badge classes, and six copies of the severity ordering — and in each
 * case every individual copy looked correct. Collapsing them is the fix where a shared
 * constant is possible; where a zod enum cannot import the source without a dependency
 * cycle, this is what stops them drifting.
 */
const root = join(import.meta.dirname, "../../..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

describe("node kinds", () => {
  it("are the same in the registry and the schema enum", () => {
    // A kind in the schema but not the registry is a node the editor will draw and the
    // engine has no spec for; the reverse is a node type nobody can save.
    const schemaKinds = GraphNodeSchema.shape.kind.options as readonly string[];
    expect([...schemaKinds].sort()).toEqual(Object.keys(NODE_SPECS).sort());
  });

  it("every registry entry agrees with its own key", () => {
    for (const [key, spec] of Object.entries(NODE_SPECS)) {
      expect(spec.kind, `NODE_SPECS["${key}"] has kind "${spec.kind}"`).toBe(key);
    }
  });
});

describe("agent tools", () => {
  const toolsSrc = read("packages/agents/src/tools.ts");

  it("every configurable tool is actually implemented", () => {
    // `toolsForAgent` filters out a name it does not recognise, silently, so a playbook
    // naming a tool that does not exist loses it with no error anywhere.
    for (const tool of AGENT_TOOLS) {
      expect(toolsSrc, `no implementation for configurable tool ${tool}`).toContain(`${tool}: {`);
    }
  });

  it("does not offer the terminal tool as a configurable one", () => {
    // submit_findings is appended by the runner and is not the user's to remove; an
    // agent without it could never report anything.
    expect(AGENT_TOOLS as readonly string[]).not.toContain("submit_findings");
    expect(toolsSrc).toContain("submit_findings");
  });
});

describe("review and task states", () => {
  const migration = read("packages/core/src/store/migrations/001_init.ts");

  it("documents every review state the code can write", () => {
    // The schema comment is the only place these are enumerated for a reader, so it
    // drifting from reality misleads exactly the person trying to understand the data.
    const comment = /state\s+TEXT NOT NULL,\s*--\s*([a-z|]+)/.exec(migration)?.[1] ?? "";
    for (const state of ["queued", "preparing", "analyzing", "triaging", "posting", "done"]) {
      expect(comment, `review state ${state} is undocumented`).toContain(state);
    }
  });

  it("documents the leaked environment state the recovery path writes", () => {
    // Recovery marks an environment `leaked` when it cannot know the container went
    // away; a state written but undocumented is one nobody knows to look for.
    expect(migration).toContain("leaked");
  });
});
