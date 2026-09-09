import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelBindingSchema } from "./schema.js";

/**
 * Guards against the bug this codebase has now produced five times: configuration that
 * is declared at one end and never read at the other.
 *
 * The scheduler, `maxPromptChars`, the Linear context, `thinkingBudget` — twice — were
 * each built correctly, exposed in the UI or the schema, and wired to nothing. None
 * produced a type error, because the fields are optional and the consumer simply never
 * mentioned them. Every one was found by a person noticing, which is not a control.
 *
 * These tests are deliberately crude: they read source text. A knob is only real when
 * something reads it, and that is a property of the repository, not of any one module.
 */

const ROOT = join(import.meta.dirname, "../../..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("model settings are wired end to end", () => {
  /** Identity of the binding, not a tunable knob: these reach the provider by other means. */
  const NOT_A_TUNABLE = new Set(["providerId", "model", "fallback"]);

  it("forwards every tunable in the schema to something that runs", () => {
    // `thinkingBudget` sat in this schema and in the Studio's model picker for the whole
    // project while the runner forwarded only temperature and maxTokens. Adding a field
    // here and forgetting the forward is a silent no-op, so the forward is asserted.
    //
    // Two consumers, not one: the runner passes per-call settings to the loop, while the
    // engine turns maxSteps and costCapCents into the budget. Checking only the runner
    // would report the budget fields as dead when they are simply read elsewhere.
    const consumers = [
      read("packages/agents/src/run-agent.ts"),
      read("packages/engine/src/engine.ts"),
    ].join("\n");
    const missing = Object.keys(ModelBindingSchema.shape)
      .filter((field) => !NOT_A_TUNABLE.has(field))
      .filter((field) => !consumers.includes(`model.${field}`));

    expect(
      missing,
      `these model settings are in the playbook schema but never read by the agent runner, ` +
        `so setting them in the Studio would silently do nothing: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("carries each tunable through the loop to the provider", () => {
    const loop = read("packages/llm/src/loop.ts");
    // The loop renames a couple on the way through; assert on what it actually passes.
    for (const field of ["temperature", "thinkingBudget"]) {
      expect(loop, `the agent loop drops ${field} before reaching the provider`).toContain(
        `${field}: opts.${field}`,
      );
    }
  });
});

describe("environment variables are discoverable", () => {
  const SOURCES = [
    "packages/core/src/paths.ts",
    "packages/core/src/logger.ts",
    "packages/llm/src/keys.ts",
    "packages/sandbox/src/docker.ts",
    "packages/sandbox/src/egress-proxy.ts",
    "apps/cli/src/commands/serve.ts",
    // The installer too: its variables are the first configuration anyone meets, and
    // MAESTRO_BASE_URL and MAESTRO_TOKEN were undocumented the moment they were added.
    "install.sh",
  ];

  it("documents every MAESTRO_ variable the code reads", () => {
    // Undocumented configuration on a self-hosted tool is configuration nobody can find.
    // Seven of these were undiscoverable until someone went looking.
    const docs = read("docs/CONFIGURATION.md");
    const found = new Set<string>();
    for (const file of SOURCES) {
      for (const m of read(file).matchAll(/MAESTRO_[A-Z_]+/g)) found.add(m[0]);
    }
    // A prefix built at runtime from a provider id, not a variable in its own right.
    found.delete("MAESTRO_KEY_");

    const undocumented = [...found].filter((v) => !docs.includes(v)).sort();
    expect(
      undocumented,
      `read by the code and documented nowhere: ${undocumented.join(", ")}`,
    ).toEqual([]);
  });

  it("documents the credential variables a fresh install needs", () => {
    const docs = read("docs/CONFIGURATION.md");
    for (const v of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GITHUB_TOKEN",
      "GITHUB_WEBHOOK_SECRET",
      "LINEAR_API_KEY",
    ]) {
      expect(docs, `${v} is not documented`).toContain(v);
    }
  });
});
