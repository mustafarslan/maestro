import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@maestro/core";
import { ProviderConfigStore, ProviderRegistry } from "@maestro/llm";
import { defaultPlaybook, PlaybookStore } from "@maestro/playbook";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { review, unresolvableAgents } from "./commands/review.js";

/**
 * A review that cannot reach any model should say so before it prepares an environment.
 *
 * Preparing one clones the repository, installs its dependencies and commits a snapshot
 * image — minutes of real work. Agent nodes are `skip-with-note`, so without this a fresh
 * install with no credentials did all of that, skipped every agent, and reported a
 * completed review with no findings.
 */
describe("a review with nowhere to send a prompt", () => {
  let home: string;
  let repo: string;
  let originalHome: string | undefined;
  let errors: string[];

  beforeEach(async () => {
    originalHome = process.env.MAESTRO_HOME;
    home = mkdtempSync(join(tmpdir(), "maestro-pre-"));
    process.env.MAESTRO_HOME = home;

    repo = join(home, "repo");
    mkdirSync(repo, { recursive: true });
    const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    execFileSync("git", ["init", "--quiet", "-b", "main", repo], { stdio: "ignore" });
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "Test"]);
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "first"]);
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    git(["commit", "--quiet", "-am", "second"]);
    errors = [];
    vi.spyOn(console, "error").mockImplementation((...a) => {
      errors.push(a.join(" "));
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const db = await openStore();
    // Every agent bound to a provider that is not registered, and no fallback.
    const doc = defaultPlaybook();
    for (const a of doc.agents) a.model = { ...a.model, providerId: "nowhere", fallback: [] };
    new PlaybookStore(db).publish(doc, { activate: true });
    new ProviderConfigStore(db).ensureDefaults();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.MAESTRO_HOME;
    else process.env.MAESTRO_HOME = originalHome;
  });

  it("refuses before touching Docker, and says how to fix it", async () => {
    // A repository built here rather than `process.cwd()`. The clean-checkout gate runs
    // from a plain directory of files with no `.git`, so reviewing the working directory
    // failed on a git error there and never reached the check under test — a test that
    // passed locally for a reason that had nothing to do with what it asserts.
    expect(await review([repo])).toBe(1);
    const said = errors.join("\n");
    expect(said).toContain("no agent can reach a model");
    expect(said).toContain("maestro llm key set");
    // Named per agent, so the answer is in the message rather than a next step.
    expect(said).toContain("security");
    // And it stopped before the sandbox: Docker is never consulted.
    expect(said).not.toContain("docker is not available");
  }, 30_000);
});

describe("which agents cannot resolve", () => {
  /**
   * The decision itself, without Docker. Driving it through `review()` a second time
   * started a real container: a review that gets past the pre-flight is a review, and a
   * test suite that quietly runs one is a test suite nobody can run offline.
   */
  const registry = new ProviderRegistry();
  registry.register({ id: "ollama", kind: "openai-compatible", baseUrl: "http://x/v1" });

  const boundTo = (ids: string[]) => {
    const doc = defaultPlaybook();
    doc.agents.forEach((a, i) => {
      a.model = { ...a.model, providerId: ids[i] ?? "nowhere", fallback: [] };
    });
    return doc;
  };

  it("names every agent whose provider is not registered", () => {
    const doc = boundTo([]);
    expect(
      unresolvableAgents(doc, registry)
        .map((b) => b.id)
        .sort(),
    ).toEqual(doc.agents.map((a) => a.id).sort());
  });

  it("says nothing about an agent that resolves", () => {
    const doc = boundTo(["ollama"]);
    const bad = unresolvableAgents(doc, registry).map((b) => b.id);
    expect(bad).not.toContain(doc.agents[0]?.id);
  });

  it("ignores a disabled agent, which was never going to run", () => {
    const doc = boundTo([]);
    for (const a of doc.agents) a.enabled = false;
    expect(unresolvableAgents(doc, registry)).toEqual([]);
  });

  it("follows a declared fallback", () => {
    // A binding whose primary is unconfigured but whose fallback is registered is a
    // working binding — that is what the fallback chain is for.
    const doc = defaultPlaybook();
    for (const a of doc.agents) {
      a.model = {
        ...a.model,
        providerId: "nowhere",
        fallback: [{ providerId: "ollama", model: "m" }],
      };
    }
    expect(unresolvableAgents(doc, registry)).toEqual([]);
  });
});
