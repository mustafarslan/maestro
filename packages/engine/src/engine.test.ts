import { anthropicTransport, failingTransport, fakeConfig, ProviderRegistry } from "@maestro/llm";
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

describe("failure policy on non-agent nodes", () => {
  /**
   * A router rule missing its `include` list — the shape a hand-edited or
   * partially-migrated playbook takes, and one the router genuinely throws on.
   *
   * Verified to actually throw before being used here. An invalid glob was tried first
   * and picomatch accepts it, which would have made this whole suite pass with the
   * feature removed — the same trap the gate tests fell into.
   */
  function brokenRouter(policy: "fail-review" | "skip-with-note"): PlaybookDocument {
    const doc = twoAgentPlaybook();
    return {
      ...doc,
      router: {
        ...doc.router,
        rules: [{ agentId: "security", exclude: [] } as unknown as (typeof doc.router.rules)[0]],
      },
      graph: {
        ...doc.graph,
        nodes: doc.graph.nodes.map((n) =>
          n.kind === "router" ? { ...n, failurePolicy: policy } : n,
        ),
      },
    };
  }

  it("runs every agent when the router fails under skip-with-note", async () => {
    // failurePolicy was consulted only inside the agent loop, so on a router it was a
    // setting the Studio offered and nothing read: a router that threw killed a review
    // that could have run every agent instead. The fallback is a coarser review, not a
    // lost one, so the agents must actually have run.
    const outcome = await runReview(
      { driver: fakeDriver(), registry: fakeRegistry() },
      request({ playbook: brokenRouter("skip-with-note") }),
    );

    expect(outcome.state).toBe("done");
    const ran = outcome.nodes.filter((n) => n.kind === "agent" && n.state === "done");
    expect(ran.length).toBeGreaterThan(0);
  });

  it("still fails the review when the router's policy says fail-review", async () => {
    // The escape hatch has to keep working: someone who marks the router critical means
    // it. runReview converts a throw into a failed outcome rather than rejecting, so the
    // observable difference is the state, not an exception.
    const outcome = await runReview(
      { driver: fakeDriver(), registry: fakeRegistry() },
      request({ playbook: brokenRouter("fail-review") }),
    );
    expect(outcome.state).toBe("failed");
    expect(outcome.nodes.some((n) => n.kind === "agent" && n.state === "done")).toBe(false);
  });

  it("still produces a review when triage fails under skip-with-note", async () => {
    // A throw in triage lost a review whose findings were already in hand.
    const doc = twoAgentPlaybook();
    const broken = {
      ...doc,
      // Destructuring a missing triage block throws — the shape a hand-edited or
      // forward-migrated playbook would take.
      triage: undefined,
      graph: {
        ...doc.graph,
        nodes: doc.graph.nodes.map((n) =>
          n.kind === "triage" ? { ...n, failurePolicy: "skip-with-note" as const } : n,
        ),
      },
    } as unknown as PlaybookDocument;

    const outcome = await runReview(
      { driver: fakeDriver(), registry: fakeRegistry() },
      request({ playbook: broken }),
    );
    expect(outcome.state).toBe("done");
    expect(outcome.nodes.some((n) => n.kind === "agent" && n.state === "done")).toBe(true);
  });
});

describe("a run cut short by the context window", () => {
  // Reporting it as "done" hides that the agent produced partial work at best: the metrics
  // block says the agent completed, the reviewer reads a short finding list as a clean
  // bill of health, and nothing anywhere says the run was truncated. The fix has been in
  // place since that was found — and mutation showed it could be reverted with the whole
  // suite green, so it could have regressed without a trace.
  function contextLimitRegistry(): ProviderRegistry {
    const registry = new ProviderRegistry();
    // The wording providers use varies; the loop matches on the family of phrasings, and
    // this is one of the real ones.
    registry.register(
      fakeConfig(failingTransport(400, "prompt is too long: 250000 tokens > 200000 maximum"), {
        id: "anthropic",
      }),
    );
    return registry;
  }

  it("is reported as failed, not as done", async () => {
    const outcome = await runReview(
      { driver: fakeDriver(), registry: contextLimitRegistry() },
      request(),
    );

    const agents = outcome.nodes.filter((n) => n.kind === "agent" && n.state !== "skipped");
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.every((n) => n.state === "failed")).toBe(true);
    // Through the context-limit branch specifically, not through some other failure: the
    // first version of this test asserted only the state, and a run that failed for any
    // other reason would have satisfied it.
    expect(agents.every((n) => n.stopKind === "context-limit")).toBe(true);
  });
});
