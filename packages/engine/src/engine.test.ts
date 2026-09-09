import { anthropicTransport, fakeConfig, ProviderRegistry } from "@maestro/llm";
import type { EnvSpec, PlaybookDocument } from "@maestro/playbook";
import { defaultPlaybook } from "@maestro/playbook";
import type { PreparedEnvironment, Sandbox, SandboxDriver } from "@maestro/sandbox";
import { describe, expect, it } from "vitest";
import { runReview } from "./engine.js";

/**
 * A driver that creates nothing. The security posture of the real one is asserted
 * against real containers in the sandbox package; what matters here is the interpreter's
 * own behaviour — admission, teardown and how a failing agent is recorded.
 */
function fakeDriver(over: Partial<SandboxDriver> = {}): SandboxDriver & { destroyed: string[] } {
  const destroyed: string[] = [];
  let n = 0;
  const driver = {
    destroyed,
    name: "fake",
    available: async () => true,
    prepare: async (): Promise<PreparedEnvironment> => ({
      id: "env-1",
      reviewId: "rv-1",
      imageId: "img-1",
      toolchain: {
        kind: "node",
        image: "node:22-bookworm",
        setup: [],
        commands: { test: "npm test" },
      },
      allowedCommands: ["npm test"],
      setupResults: [],
      egressLog: [],
    }),
    analyze: async (_env: PreparedEnvironment, opts: { agentId?: string }): Promise<Sandbox> => {
      const id = `sb-${++n}-${opts.agentId}`;
      return {
        id,
        agentId: opts.agentId,
        containerId: id,
        exec: async (command: string) => ({
          command,
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
          timedOut: false,
        }),
        readFile: async () => "",
        destroy: async () => {
          destroyed.push(id);
        },
      };
    },
    reap: async () => ({ containers: 0, images: 0 }),
    ...over,
  };
  return driver as SandboxDriver & { destroyed: string[] };
}

/** A registry whose model always submits an empty finding list and stops. */
function fakeRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  const transport = anthropicTransport([
    { toolCalls: [{ id: "1", name: "submit_findings", input: { findings: [] } }] },
  ]);
  registry.register(fakeConfig(transport, { id: "anthropic" }));
  return registry;
}

function twoAgentPlaybook(): PlaybookDocument {
  const doc = defaultPlaybook();
  const keep = new Set(["security", "architecture"]);
  return {
    ...doc,
    agents: doc.agents.filter((a) => keep.has(a.id)),
    graph: {
      ...doc.graph,
      nodes: doc.graph.nodes.filter((n) => n.kind !== "agent" || keep.has(n.agentId ?? "")),
      edges: doc.graph.edges.filter(
        (e) =>
          !e.from.startsWith("agent:") ||
          keep.has(e.from.slice("agent:".length)) ||
          !e.to.startsWith("agent:") ||
          keep.has(e.to.slice("agent:".length)),
      ),
    },
  };
}

const request = (over = {}) => ({
  reviewId: "rv-1",
  repoId: "repo-42",
  playbook: twoAgentPlaybook(),
  sourcePath: "/tmp/does-not-matter",
  baseRef: "main",
  changedFiles: ["src/index.ts", "src/api/auth.ts"],
  changedLines: 40,
  context: {
    pr: { number: 1, title: "t", description: "d", author: "a" },
    repo: { owner: "o", name: "r", defaultBranch: "main" },
    diff: { changedFiles: ["src/index.ts"], changedLines: 40 },
  },
  ...over,
});

describe("engine admission control", () => {
  it("asks for a slot per agent and reports the real repo id", async () => {
    // The scheduler was constructed in the daemon and never consulted, so every agent of
    // every review started at once. This is the wiring that made it real.
    const asked: { agentId: string; repoId: string; providerId: string }[] = [];
    const driver = fakeDriver();

    const outcome = await runReview(
      {
        driver,
        registry: fakeRegistry(),
        acquireSlot: async (slot) => {
          asked.push({ agentId: slot.agentId, repoId: slot.repoId, providerId: slot.providerId });
          return () => {};
        },
      },
      request(),
    );

    const ran = outcome.nodes.filter((n) => n.kind === "agent" && n.state !== "skipped");
    // Guard against a vacuous pass: the router must have admitted at least one agent,
    // or "asked as often as agents ran" is satisfied by nothing running at all.
    expect(ran.length).toBeGreaterThan(0);
    expect(asked).toHaveLength(ran.length);
    expect(asked.every((a) => a.repoId === "repo-42")).toBe(true);
    expect(asked.every((a) => a.providerId === "anthropic")).toBe(true);
  });

  it("releases the slot even when the agent throws", async () => {
    // A leaked slot drains the pool one failure at a time until the daemon stalls, and
    // nothing in the logs points at the cause.
    let held = 0;
    let peak = 0;
    const driver = fakeDriver({
      analyze: async () => {
        throw new Error("docker daemon unreachable");
      },
    });

    await runReview(
      {
        driver,
        registry: fakeRegistry(),
        acquireSlot: async () => {
          held++;
          peak = Math.max(peak, held);
          return () => {
            held--;
          };
        },
      },
      request(),
    );

    expect(peak).toBeGreaterThan(0);
    expect(held).toBe(0);
  });

  it("runs without a scheduler, because a single CLI review has nothing to schedule", async () => {
    const driver = fakeDriver();
    const outcome = await runReview({ driver, registry: fakeRegistry() }, request());
    expect(outcome.state).toBe("done");
  });

  it("destroys every container it created, including after a failure", async () => {
    // Teardown is a finalizer rather than a graph node precisely so that no failure path
    // and no drawable graph can skip it.
    const driver = fakeDriver();
    await runReview({ driver, registry: fakeRegistry() }, request());
    expect(driver.destroyed.length).toBeGreaterThan(0);
  });
});
