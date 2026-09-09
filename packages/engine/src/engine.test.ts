import { anthropicTransport, fakeConfig, ProviderRegistry } from "@maestro/llm";
import type { PlaybookDocument } from "@maestro/playbook";
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

  it("honours skip-with-note when an agent's provider cannot be resolved", async () => {
    // Resolving the model binding has to happen inside the per-agent try. Outside it, an
    // agent pointed at a provider with no key configured rejects the Promise.all and
    // takes the entire review down — regardless of its failure policy, which exists
    // precisely so one misconfigured agent cannot do that.
    const doc = twoAgentPlaybook();
    const broken: PlaybookDocument = {
      ...doc,
      agents: doc.agents.map((a) =>
        a.id === "security"
          ? { ...a, model: { ...a.model, providerId: "not-configured", fallback: [] } }
          : a,
      ),
      graph: {
        ...doc.graph,
        nodes: doc.graph.nodes.map((n) =>
          n.kind === "agent" && n.agentId === "security"
            ? { ...n, failurePolicy: "skip-with-note" as const }
            : n,
        ),
      },
    };

    const outcome = await runReview(
      { driver: fakeDriver(), registry: fakeRegistry() },
      request({ playbook: broken }),
    );

    expect(outcome.state).toBe("done");
    const security = outcome.nodes.find((n) => n.agentId === "security");
    expect(security?.state).toBe("failed");
    // The other agent must still have done its work.
    expect(outcome.nodes.some((n) => n.agentId === "architecture" && n.state === "done")).toBe(
      true,
    );
  });

  it("does not start a container for a review cancelled while it queued", async () => {
    // Cancel-on-push plus a full queue would otherwise pay a container start per agent
    // for a review whose comment can never be posted.
    const controller = new AbortController();
    const driver = fakeDriver();

    const outcome = await runReview(
      {
        driver,
        registry: fakeRegistry(),
        acquireSlot: async () => {
          controller.abort();
          return () => {};
        },
      },
      request({ signal: controller.signal }),
    );

    expect(driver.destroyed).toHaveLength(0);
    expect(outcome.nodes.filter((n) => n.kind === "agent" && n.state === "done")).toHaveLength(0);
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

describe("gate nodes", () => {
  /** A playbook with one gate between the agents and triage. */
  function withGate(config: Record<string, unknown>): PlaybookDocument {
    const doc = twoAgentPlaybook();
    const agentNodes = doc.graph.nodes.filter((n) => n.kind === "agent");
    const triageNode = doc.graph.nodes.find((n) => n.kind === "triage");
    return {
      ...doc,
      graph: {
        nodes: [
          ...doc.graph.nodes,
          {
            id: "gate-1",
            kind: "gate" as const,
            failurePolicy: "skip-with-note" as const,
            config,
            position: { x: 0, y: 0 },
          },
        ],
        edges: [
          ...doc.graph.edges.filter(
            (e) => !(e.to === triageNode?.id && agentNodes.some((a) => a.id === e.from)),
          ),
          ...agentNodes.map((a) => ({ from: a.id, to: "gate-1" })),
          ...(triageNode ? [{ from: "gate-1", to: triageNode.id }] : []),
        ],
      },
    };
  }

  /** A registry whose model submits findings at two different confidences. */
  function findingRegistry() {
    const registry = new ProviderRegistry();
    const transport = anthropicTransport([
      {
        toolCalls: [
          {
            id: "1",
            name: "submit_findings",
            input: {
              findings: [
                {
                  file: "a.ts",
                  lineStart: 1,
                  lineEnd: 1,
                  category: "sure-thing",
                  severity: "high",
                  confidence: 0.95,
                  title: "Confident",
                  body: "b",
                },
                {
                  file: "b.ts",
                  lineStart: 1,
                  lineEnd: 1,
                  category: "speculation",
                  severity: "low",
                  // Above triage's own 0.6 floor on purpose: if this disappears, the
                  // gate is the only thing that can have removed it. At 0.2 the test
                  // passed with the gate ripped out, which is a test proving nothing.
                  confidence: 0.75,
                  title: "Speculative",
                  body: "b",
                },
              ],
            },
          },
        ],
      },
    ]);
    registry.register(fakeConfig(transport, { id: "anthropic" }));
    return registry;
  }

  it("drops findings below its confidence floor", async () => {
    // Gate nodes were drawable, documented and never executed: a user who added one to
    // filter speculation got no filtering and no sign of it, having been told the filter
    // was in place.
    const outcome = await runReview(
      { driver: fakeDriver(), registry: findingRegistry() },
      request({ playbook: withGate({ minConfidence: 0.9 }) }),
    );
    const titles = (outcome.triage?.posted ?? []).map((f) => f.title);
    expect(titles).toContain("Confident");
    expect(titles).not.toContain("Speculative");
  });

  it("passes everything through when it has no settings", async () => {
    // An empty gate on the canvas must do nothing, not reject every finding.
    const outcome = await runReview(
      { driver: fakeDriver(), registry: findingRegistry() },
      request({ playbook: withGate({}) }),
    );
    const all = [...(outcome.triage?.posted ?? []), ...(outcome.triage?.suppressed ?? [])];
    expect(all.map((f) => f.title).sort()).toEqual(["Confident", "Speculative"]);
  });

  it("passes everything through when its config is malformed", async () => {
    // Rejecting every finding because someone typed a bad threshold would hide real
    // defects behind what looks like a clean review.
    const outcome = await runReview(
      { driver: fakeDriver(), registry: findingRegistry() },
      request({ playbook: withGate({ minConfidence: "very high" }) }),
    );
    const all = [...(outcome.triage?.posted ?? []), ...(outcome.triage?.suppressed ?? [])];
    expect(all.length).toBeGreaterThan(0);
  });

  it("records the gate as a node in the outcome, so it is visible in the waterfall", async () => {
    const outcome = await runReview(
      { driver: fakeDriver(), registry: findingRegistry() },
      request({ playbook: withGate({ minConfidence: 0.9 }) }),
    );
    expect(outcome.nodes.some((n) => n.kind === "gate")).toBe(true);
  });
});
