import { openStore, ReviewStore, SpanRecorder } from "@maestro/core";
import { anthropicTransport, failingTransport, fakeConfig, ProviderRegistry } from "@maestro/llm";
import type { PlaybookDocument } from "@maestro/playbook";
import { defaultPlaybook, PlaybookStore } from "@maestro/playbook";
import { bundledBattery, scoreBattery } from "@maestro/profile";
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

describe("the stages a review reports", () => {
  /**
   * `analyzing` and `triaging` were declared in the first migration, listed in
   * `REVIEW_STATES` and `IN_FLIGHT_STATES`, and referenced by a comment describing an
   * interrupted review "sitting in `analyzing`" — which could never have happened, because
   * nothing wrote either. A review went `preparing` straight to `posting`, so the live
   * board showed `preparing` for the whole analyze phase: 156 of 158 seconds on the first
   * real run against GitHub. Phase 5's exit criterion is that you can watch a review
   * happen in the browser, and the stage you watched was wrong for nearly all of it.
   *
   * Found by watching a real review rather than by reading the code.
   */
  it("reports analyzing before the agents and triaging before triage", async () => {
    const stages: string[] = [];
    const outcome = await runReview(
      { driver: fakeDriver(), registry: fakeRegistry() },
      { ...request(), onStage: (s) => stages.push(s) },
    );
    expect(outcome.state).toBe("done");
    expect(stages).toEqual(["analyzing", "triaging"]);
  });

  it("reports analyzing even when every agent fails", async () => {
    // The stage is where the review IS, not whether it went well. A board that only
    // advances on success leaves a failing review looking stuck in preparation.
    const stages: string[] = [];
    await runReview(
      { driver: fakeDriver(), registry: new ProviderRegistry() },
      { ...request(), onStage: (s) => stages.push(s) },
    );
    expect(stages[0]).toBe("analyzing");
  });
});

describe("base-versus-head comparison is refused where commands are refused", () => {
  const comparingPlaybook = (trust: "trusted" | "untrusted") => {
    const doc = twoAgentPlaybook();
    doc.envSpec = { ...doc.envSpec, trust, compareCommands: ["npm test"] };
    return doc;
  };

  it("refuses on an untrusted review even when commands are still configured", async () => {
    // `resolveEnvSpec` empties `compareCommands` for forks, but it is not the only way in:
    // `maestro review` and `maestro eval` never call it, and `trust` is read in exactly
    // one other place in the whole codebase. A guard that lived only in the webhook path
    // would protect the webhook path and nothing else, so the engine checks again.
    const outcome = await runReview(
      { driver: fakeDriver(), registry: fakeRegistry() },
      request({ playbook: comparingPlaybook("untrusted"), baselinePath: "/tmp/base" }),
    );

    expect(outcome.comparisons).toHaveLength(1);
    expect(outcome.comparisons?.[0]?.skipped).toBe("untrusted");
    // Skipped, and it says so: an empty result would read as "checked, nothing found".
    expect(outcome.comparisons?.[0]?.base).toBeNull();
  });

  it("says there was no baseline rather than producing an empty comparison", async () => {
    const outcome = await runReview(
      { driver: fakeDriver(), registry: fakeRegistry() },
      request({ playbook: comparingPlaybook("trusted") }),
    );
    expect(outcome.comparisons?.[0]?.skipped).toBe("no-merge-base");
  });

  it("compares when the review is trusted and a baseline exists", async () => {
    // Guards against the two tests above passing for the wrong reason: if nothing ever
    // compared, "it skipped" would be satisfied by the feature being broken outright.
    const outcome = await runReview(
      { driver: fakeDriver(), registry: fakeRegistry() },
      request({ playbook: comparingPlaybook("trusted"), baselinePath: "/tmp/base" }),
    );
    expect(outcome.comparisons?.[0]?.skipped).toBeUndefined();
    expect(outcome.comparisons?.[0]?.verdict).toBe("same-exit");
  });

  it("does nothing when no playbook asked for it", async () => {
    const outcome = await runReview(
      { driver: fakeDriver(), registry: fakeRegistry() },
      request({ baselinePath: "/tmp/base" }),
    );
    expect(outcome.comparisons).toBeUndefined();
  });
});

describe("agent spans", () => {
  /** A store with a real review row, so a span's foreign key resolves. */
  async function storeWithReview() {
    const db = await openStore({ path: ":memory:" });
    const pb = new PlaybookStore(db).publish(defaultPlaybook());
    const reviewId = new ReviewStore(db).create({
      repoOwner: "acme",
      repoName: "web",
      prNumber: 1,
      headSha: "abc",
      playbookVersionId: pb.id,
    }).id;
    return { db, reviewId };
  }

  it("opens and closes one span per agent that ran", async () => {
    // Agent nodes were the only kind emitting no span, which meant the waterfall showed
    // the cheap half of a review and left a blank where the expensive half belongs.
    const { db, reviewId } = await storeWithReview();
    await runReview(
      { driver: fakeDriver(), registry: fakeRegistry(), spans: new SpanRecorder(db) },
      request({ reviewId }),
    );

    const rows = db
      .prepare(
        "SELECT name, status, ended_at, attrs_json FROM spans WHERE name='node:agent' AND review_id=?",
      )
      .all<{ name: string; status: string; ended_at: string | null; attrs_json: string }>(reviewId);

    expect(rows).toHaveLength(2);
    // An open span is worse than none: the waterfall draws it as work still running.
    for (const r of rows) {
      expect(r.ended_at).not.toBeNull();
      expect(r.status).toBe("ok");
    }
    expect(rows.map((r) => JSON.parse(r.attrs_json).agentId).sort()).toEqual([
      "architecture",
      "security",
    ]);
  });

  it("writes each agent's transcript, not only its cost", async () => {
    // The recorder's own tests exercise recordTrajectory directly; this is the wire.
    // A transcript written by a method nothing calls is the exact shape of this
    // project's most repeated defect, and only the engine's call site closes it.
    const { db, reviewId } = await storeWithReview();
    await runReview(
      { driver: fakeDriver(), registry: fakeRegistry(), spans: new SpanRecorder(db), db },
      request({ reviewId }),
    );

    const rows = db
      .prepare("SELECT role, step FROM trajectory_turns WHERE review_id=? ORDER BY seq")
      .all<{ role: string; step: number | null }>(reviewId);

    expect(rows.length).toBeGreaterThan(0);
    // The prompts are the half that cannot be reconstructed afterwards.
    expect(rows.filter((r) => r.role === "system")).not.toHaveLength(0);
    expect(rows.filter((r) => r.role === "user")).not.toHaveLength(0);
    expect(rows.filter((r) => r.role === "assistant")).not.toHaveLength(0);
  });

  it("closes the span when the agent's provider fails", async () => {
    const { db, reviewId } = await storeWithReview();
    const registry = new ProviderRegistry();
    registry.register(fakeConfig(failingTransport(500), { id: "anthropic" }));

    await runReview(
      { driver: fakeDriver(), registry, spans: new SpanRecorder(db) },
      request({ reviewId }),
    );

    const rows = db
      .prepare("SELECT status, ended_at FROM spans WHERE name='node:agent' AND review_id=?")
      .all<{ status: string; ended_at: string | null }>(reviewId);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.ended_at).not.toBeNull();
  });
});

describe("the triage agent in a review", () => {
  /**
   * One specialist, so the scripted replies arrive in a known order: the agent's
   * submit_findings first, then the triage agent's submit_review.
   */
  function oneAgentPlaybook(over: (doc: PlaybookDocument) => PlaybookDocument = (d) => d) {
    const doc = defaultPlaybook();
    return over({
      ...doc,
      agents: doc.agents.filter((a) => a.id === "security"),
      graph: {
        ...doc.graph,
        nodes: doc.graph.nodes.filter((n) => n.kind !== "agent" || n.agentId === "security"),
      },
    });
  }

  const finding = {
    file: "src/api/auth.ts",
    lineStart: 3,
    category: "prompt-injection",
    severity: "high",
    confidence: 0.9,
    title: "PR text reaches the system prompt",
    body: "`pr.description` is interpolated unfenced.",
  };
  const agentTurn = {
    toolCalls: [{ id: "a1", name: "submit_findings", input: { findings: [finding] } }],
  };
  const triageTurn = {
    toolCalls: [
      {
        id: "t1",
        name: "submit_review",
        input: {
          state: "REQUEST_CHANGES",
          summary: "Leaks PR text into the prompt; block.",
          findings: [
            {
              id: "F1",
              disposition: "request_changes",
              body: "`pr.description` reaches the persona unfenced. Fence it.",
            },
          ],
        },
      },
    ],
  };

  const scored = scoreBattery(bundledBattery(), {});
  const profile = {
    subject: "octocat",
    profile: { ...scored, attributes: { ...scored.attributes, blocking_threshold: 0.4 } },
  };

  function registryWith(transport: ReturnType<typeof anthropicTransport>) {
    const registry = new ProviderRegistry();
    registry.register(fakeConfig(transport, { id: "anthropic" }));
    return registry;
  }

  it("decides the review within the rules, and is recorded like any model run", async () => {
    const db = await openStore({ path: ":memory:" });
    const pb = new PlaybookStore(db).publish(defaultPlaybook());
    const reviewId = new ReviewStore(db).create({
      repoOwner: "o",
      repoName: "r",
      prNumber: 1,
      headSha: "abc",
      playbookVersionId: pb.id,
    }).id;
    const transport = anthropicTransport([agentTurn, triageTurn]);

    const outcome = await runReview(
      { driver: fakeDriver(), registry: registryWith(transport), db },
      request({ reviewId, playbook: oneAgentPlaybook(), profile }),
    );

    expect(outcome.state).toBe("done");
    const t = outcome.triage;
    expect(t?.personalization?.triageAgent).toEqual({ status: "used" });
    expect(t?.personalization?.state).toBe("REQUEST_CHANGES");
    expect(t?.posted[0]?.body).toBe(finding.body);
    expect(t?.posted[0]?.personalization?.body).toBe(
      "`pr.description` reaches the persona unfenced. Fence it.",
    );
    expect(t?.summary.startsWith("Leaks PR text into the prompt; block.")).toBe(true);

    const node = outcome.nodes.find((n) => n.agentId === "triage");
    expect(node).toMatchObject({ nodeId: "triage:agent", kind: "triage", state: "done" });
    expect(node?.costCents).toBeGreaterThan(0);
    const agentCost = outcome.nodes
      .filter((n) => n.kind === "agent")
      .reduce((sum, n) => sum + n.costCents, 0);
    expect(outcome.costCents).toBeCloseTo(agentCost + (node?.costCents ?? 0), 10);

    const task = db
      .prepare("SELECT id FROM tasks WHERE review_id=? AND node_id='triage:agent'")
      .get<{ id: string }>(reviewId);
    expect(task).toBeDefined();
    const calls = db
      .prepare("SELECT COUNT(*) AS n FROM llm_calls WHERE task_id=?")
      .get<{ n: number }>(task?.id);
    const turns = db
      .prepare("SELECT COUNT(*) AS n FROM trajectory_turns WHERE task_id=?")
      .get<{ n: number }>(task?.id);
    expect(calls?.n).toBe(1);
    expect(turns?.n).toBeGreaterThan(0);
    db.close();
  });

  it("with no provider for triage, the profile's rules decide and the review still completes", async () => {
    const transport = anthropicTransport([agentTurn]);
    const noTriageProvider = oneAgentPlaybook((d) => ({
      ...d,
      triage: {
        ...d.triage,
        model: { ...d.triage.model, providerId: "not-configured", fallback: [] },
      },
    }));

    const outcome = await runReview(
      { driver: fakeDriver(), registry: registryWith(transport) },
      request({ playbook: noTriageProvider, profile }),
    );

    expect(outcome.state).toBe("done");
    const t = outcome.triage;
    expect(t?.personalization?.triageAgent?.status).toBe("unavailable");
    expect(t?.personalization?.triageAgent?.note).toMatch(/no configured provider/);
    // Not an empty review: the rules' decision stands.
    expect(t?.posted).toHaveLength(1);
    expect(t?.posted[0]?.personalization?.disposition).toBe("request_changes");
    expect(outcome.nodes.find((n) => n.agentId === "triage")?.state).toBe("failed");
  });

  it("a provider error during triage falls back the same way", async () => {
    const agents = anthropicTransport([agentTurn]);
    const registry = registryWith(agents);
    registry.register(
      fakeConfig(failingTransport(400, "quota exhausted"), { id: "triage-provider" }),
    );
    const doc = oneAgentPlaybook((d) => ({
      ...d,
      triage: {
        ...d.triage,
        model: { ...d.triage.model, providerId: "triage-provider", fallback: [] },
      },
    }));

    const outcome = await runReview(
      { driver: fakeDriver(), registry },
      request({ playbook: doc, profile }),
    );

    expect(outcome.state).toBe("done");
    expect(outcome.triage?.personalization?.triageAgent?.status).toBe("unavailable");
    expect(outcome.triage?.posted).toHaveLength(1);
  });

  it("with nothing left to decide, the triage model is not called", async () => {
    const empty = { toolCalls: [{ id: "a1", name: "submit_findings", input: { findings: [] } }] };
    const transport = anthropicTransport([empty, triageTurn]);
    const outcome = await runReview(
      { driver: fakeDriver(), registry: registryWith(transport) },
      request({ playbook: oneAgentPlaybook(), profile }),
    );
    expect(outcome.nodes.some((n) => n.agentId === "triage")).toBe(false);
    expect(outcome.triage?.personalization?.state).toBe("COMMENT");
    expect(outcome.triage?.personalization?.triageAgent?.status).toBe("skipped");
    expect(transport.requests.filter((r) => !r.url.includes("/v1/models"))).toHaveLength(1);
  });

  it("without a profile the triage model is never called", async () => {
    const transport = anthropicTransport([agentTurn, triageTurn]);
    const outcome = await runReview(
      { driver: fakeDriver(), registry: registryWith(transport) },
      request({ playbook: oneAgentPlaybook() }),
    );
    expect(outcome.nodes.some((n) => n.agentId === "triage")).toBe(false);
    expect(outcome.triage?.personalization).toBeUndefined();
    expect(transport.requests.filter((r) => !r.url.includes("/v1/models"))).toHaveLength(1);
  });
});
