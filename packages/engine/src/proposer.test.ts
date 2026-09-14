import { join } from "node:path";
import { newId, openStore, ReviewStore, type SqlDatabase } from "@maestro/core";
import { defaultPlaybook, PlaybookStore } from "@maestro/playbook";
import { beforeEach, describe, expect, it } from "vitest";
import { type EvalScore, type Fixture, loadFixtures, splitOf } from "./eval.js";
import {
  applyProposal,
  buildEvidence,
  heldOutLeaks,
  MAX_EDITS,
  type Proposal,
  parseProposal,
  proposeCandidate,
  proposerPrompt,
  recordGateDecision,
} from "./proposer.js";
import { gateCandidate, priorRejections } from "./refine.js";

/**
 * The refinement proposer, up to the model call. Everything here runs offline; the proposal
 * a model would write is written by the test.
 */

const doc = defaultPlaybook();
const agentId = doc.agents[0]?.id as string;
const agentNode = doc.graph.nodes.find((n) => n.kind === "agent")?.id as string;
const nonAgentNode = doc.graph.nodes.find((n) => n.kind === "triage")?.id as string;

const proposal = (edits: Proposal["edits"]): Proposal => ({ rationale: "because", edits });

describe("what a candidate may change", () => {
  it("an agent persona and the triage thresholds", () => {
    const r = applyProposal(
      doc,
      proposal([
        { path: `agents.${agentId}.persona`, value: "Check every loop bound." },
        { path: "triage.minConfidence", value: 0.5 },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.agents[0]?.persona).toBe("Check every loop bound.");
    expect(r.doc.triage.minConfidence).toBe(0.5);
    // The original is never touched.
    expect(doc.triage.minConfidence).toBe(0.6);
  });

  it("a procedural graph on an agent node, validated", () => {
    const graph = {
      nodes: [{ id: "Start" }, { id: "git_diff" }],
      edges: [{ from: "Start", to: "git_diff", guidance: "Read the diff first." }],
    };
    const r = applyProposal(
      doc,
      proposal([{ path: `nodes.${agentNode}.proceduralGraph`, value: graph }]),
    );
    expect(r.ok).toBe(true);
    const bad = applyProposal(
      doc,
      proposal([{ path: `nodes.${agentNode}.proceduralGraph`, value: { nodes: [] } }]),
    );
    expect(bad.ok).toBe(false);
  });

  it.each([
    [`agents.${agentId}.model.providerId`, "cheap"],
    ["graph.edges", []],
    ["router.budgetTiers", []],
    ["triage.persona", "be nicer"],
    ["envSpec.allowedCommands", ["curl"]],
  ])("refuses %s", (path, value) => {
    const r = applyProposal(doc, proposal([{ path, value }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toMatch(/not a field a candidate may change/);
  });

  it("refuses a value out of range, an unknown agent, and a graph on the wrong node", () => {
    const r = applyProposal(
      doc,
      proposal([
        { path: "triage.minConfidence", value: 1.5 },
        { path: "agents.nobody.persona", value: "x" },
        { path: `nodes.${nonAgentNode}.proceduralGraph`, value: { nodes: [{ id: "Start" }] } },
      ]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toHaveLength(3);
    expect(r.problems[1]).toBe("agents.nobody.persona: no agent 'nobody'");
    expect(r.problems[2]).toMatch(/belongs on an agent node/);
  });

  it("refuses a proposal that changes nothing, or edits one field twice", () => {
    const same = applyProposal(doc, proposal([{ path: "triage.minConfidence", value: 0.6 }]));
    expect(same).toEqual({ ok: false, problems: ["the proposal changes nothing"] });
    const twice = applyProposal(
      doc,
      proposal([
        { path: "triage.minConfidence", value: 0.5 },
        { path: "triage.minConfidence", value: 0.4 },
      ]),
    );
    expect(twice.ok).toBe(false);
  });
});

describe("parsing a proposal out of an answer", () => {
  it("finds the JSON however it is wrapped", () => {
    const text =
      'Here you go:\n```json\n{"rationale":"r","edits":[{"path":"triage.minConfidence","value":0.5}]}\n```';
    const r = parseProposal(text);
    expect(r.ok).toBe(true);
  });

  it("refuses too many edits, and no JSON at all", () => {
    const many = {
      rationale: "r",
      edits: Array.from({ length: MAX_EDITS + 1 }, () => ({ path: "x", value: 1 })),
    };
    expect(parseProposal(JSON.stringify(many)).ok).toBe(false);
    expect(parseProposal("I would lower the threshold.")).toEqual({
      ok: false,
      problems: ["no JSON object in the answer"],
    });
  });
});

describe("the evidence a round is shown", () => {
  /** The real golden set, so the no-leak property is checked against real names and patterns. */
  const fixtures: Fixture[] = loadFixtures(join(import.meta.dirname, "../../../docs/golden-set"));

  const scoreFor = (f: Fixture, over: Partial<EvalScore> = {}): EvalScore => ({
    fixture: f.name,
    playbookVersionId: "pv_x",
    split: splitOf(f),
    hits: [],
    misses: f.expected.map((e) => e.description ?? e.match),
    falsePositives: [],
    unclassified: 0,
    recall: 0,
    costCents: 1,
    durationMs: 1,
    agentsRun: 1,
    recordedAt: new Date().toISOString(),
    ...over,
  });

  it("has held-out and training fixtures to check against", () => {
    expect(fixtures.filter((f) => splitOf(f) === "val").length).toBeGreaterThan(0);
    expect(fixtures.filter((f) => splitOf(f) === "train").length).toBeGreaterThan(0);
  });

  it("carries training misses and nothing held out, over every fixture in the golden set", () => {
    const scores = fixtures.map((f) => scoreFor(f));
    const evidence = buildEvidence({ scores, fixtures, versionId: "pv_x" });
    expect(evidence.fixtures.map((f) => f.name).sort()).toEqual(
      fixtures
        .filter((f) => splitOf(f) === "train")
        .map((f) => f.name)
        .sort(),
    );
    const prompt = proposerPrompt(doc, evidence, [], fixtures);
    expect(prompt.leaks).toEqual([]);
    const aTrainMiss = evidence.fixtures[0]?.misses[0] as string;
    expect(prompt.user).toContain(`missed: ${aTrainMiss}`);
  });

  it("reports a held-out fixture that reaches the prompt", () => {
    const val = fixtures.find((f) => splitOf(f) === "val") as Fixture;
    expect(heldOutLeaks(`look at ${val.name}`, fixtures)).toEqual([`fixture name '${val.name}'`]);
  });

  it("uses only the version asked about, and its newest training run", () => {
    const train = fixtures.find((f) => splitOf(f) === "train") as Fixture;
    const scores = [
      scoreFor(train, { recall: 0.1, recordedAt: "2026-09-01T00:00:00Z" }),
      scoreFor(train, { recall: 0.9, recordedAt: "2026-09-02T00:00:00Z" }),
      scoreFor(train, { playbookVersionId: "pv_other", recall: 0.5 }),
    ];
    const evidence = buildEvidence({ scores, fixtures: [train], versionId: "pv_x" });
    expect(evidence.fixtures).toHaveLength(1);
    expect(evidence.fixtures[0]?.recall).toBe(0.9);
  });

  describe("with the agents' trajectories", () => {
    let db: SqlDatabase;
    beforeEach(async () => {
      db = await openStore({ path: ":memory:" });
    });

    it("summarises the tool calls of a run that missed, fenced as repository data", () => {
      const pb = new PlaybookStore(db).publish(defaultPlaybook());
      const reviewId = new ReviewStore(db).create({
        repoOwner: "eval",
        repoName: "x",
        prNumber: 0,
        headSha: "h",
        playbookVersionId: pb.id,
      }).id;
      const taskId = newId("tk");
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO tasks (id, review_id, node_id, kind, agent_id, state, attempt, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(taskId, reviewId, "n-security", "agent", "security", "done", 1, now);
      db.prepare(
        `INSERT INTO trajectory_turns (id, review_id, task_id, seq, step, role, content_json, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        newId("turn"),
        reviewId,
        taskId,
        0,
        0,
        "assistant",
        JSON.stringify({
          text: "",
          toolCalls: [{ id: "1", name: "read_file", input: { path: "src/a.ts" } }],
        }),
        now,
      );
      const train = fixtures.find((f) => splitOf(f) === "train") as Fixture;
      const evidence = buildEvidence({
        db,
        scores: [scoreFor(train, { reviewId })],
        fixtures: [train],
        versionId: "pv_x",
      });
      expect(evidence.fixtures[0]?.trajectory).toBe('security: read_file {"path":"src/a.ts"}');
      const prompt = proposerPrompt(doc, evidence, [], fixtures);
      expect(prompt.user).toMatch(
        new RegExp(`<untrusted-content source="trajectory-${train.name}"`),
      );
    });
  });
});

describe("a round, from proposal to recorded decision", () => {
  let db: SqlDatabase;
  let fromId: string;
  let playbookId: string;

  beforeEach(async () => {
    db = await openStore({ path: ":memory:" });
    const published = new PlaybookStore(db).publish(defaultPlaybook(), {
      name: "default",
      activate: true,
    });
    fromId = published.id;
    playbookId = published.playbookId;
  });

  it("an invalid proposal is refused and remembered", () => {
    const r = proposeCandidate(db, {
      fromVersionId: fromId,
      proposal: proposal([{ path: "graph.edges", value: [] }]),
    });
    expect(r.ok).toBe(false);
    const [memory] = priorRejections(db, playbookId);
    expect(memory?.decision).toBe("invalid");
    expect(memory?.reason).toMatch(/not a field a candidate may change/);
  });

  it("an answer that is not JSON is refused and remembered", () => {
    const r = proposeCandidate(db, { fromVersionId: fromId, proposal: "lower the threshold" });
    expect(r.ok).toBe(false);
    expect(priorRejections(db, playbookId)[0]?.reason).toBe("no JSON object in the answer");
  });

  it("a valid proposal becomes an inactive candidate in the same playbook, marked as the refiner's", () => {
    const r = proposeCandidate(db, {
      fromVersionId: fromId,
      proposal: JSON.stringify(proposal([{ path: "triage.minConfidence", value: 0.5 }])),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const store = new PlaybookStore(db);
    expect(r.candidate.playbookId).toBe(playbookId);
    expect(r.candidate.createdBy).toBe("refiner");
    expect(store.getActive("default")?.id).toBe(fromId);
    expect(JSON.parse(r.candidate.notes ?? "{}").refinement.edits[0].path).toBe(
      "triage.minConfidence",
    );
    // Not judged yet, so not remembered yet.
    expect(priorRejections(db, playbookId)).toEqual([]);
  });

  it("the gate's decision is recorded with the edit as published", () => {
    const r = proposeCandidate(db, {
      fromVersionId: fromId,
      proposal: proposal([{ path: "triage.minConfidence", value: 0.5 }]),
    });
    if (!r.ok) throw new Error("expected a candidate");
    const decision = gateCandidate([], fromId, r.candidate.id);
    recordGateDecision(db, fromId, r.candidate.id, decision);
    const [memory] = priorRejections(db, playbookId);
    expect(memory?.decision).toBe("rejected");
    expect(memory?.candidateVersionId).toBe(r.candidate.id);
    expect((memory?.edit as Proposal | undefined)?.edits[0]?.value).toBe(0.5);

    // And the next round is shown it.
    const prompt = proposerPrompt(
      defaultPlaybook(),
      { versionId: fromId, fixtures: [] },
      priorRejections(db, playbookId),
      [],
    );
    expect(prompt.user).toContain("ALREADY TRIED:");
    expect(prompt.user).toContain('"triage.minConfidence"');
  });
});
