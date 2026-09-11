import { openStore, type SqlDatabase } from "@maestro/core";
import { defaultPlaybook, PlaybookStore } from "@maestro/playbook";
import { beforeEach, describe, expect, it } from "vitest";
import type { EvalScore } from "./eval.js";
import { gateCandidate, priorRejections, recordAttempt } from "./refine.js";

/**
 * The validation gate, which is the half of arXiv:2609.09153's self-evolution loop that
 * does not need a model.
 *
 * Scores are synthetic here on purpose: what is under test is the decision, and feeding it
 * real runs would test the provider. Whether a real candidate ever clears this gate is a
 * separate question and an unanswered one — see `docs/STATUS.md` finding 241.
 */
const score = (over: Partial<EvalScore> & Pick<EvalScore, "fixture">): EvalScore => ({
  playbookVersionId: "pv_from",
  split: "val",
  hits: [],
  misses: [],
  falsePositives: [],
  unclassified: 0,
  recall: 1,
  precision: 1,
  costCents: 0,
  durationMs: 1,
  agentsRun: 1,
  recordedAt: new Date().toISOString(),
  ...over,
});

/** `n` held-out fixtures under one version, with the given recalls. */
const arm = (versionId: string, recalls: number[], split: "val" | "train" = "val") =>
  recalls.map((r, i) =>
    score({ fixture: `f${i}`, playbookVersionId: versionId, recall: r, split }),
  );

describe("the gate a candidate has to clear", () => {
  it("accepts a candidate that gains two fixtures", () => {
    const scores = [...arm("pv_from", [0, 0, 1, 1]), ...arm("pv_cand", [1, 1, 1, 1])];
    const d = gateCandidate(scores, "pv_from", "pv_cand");
    expect(d.accepted).toBe(true);
    expect(d.gained).toEqual(["f0", "f1"]);
    expect(d.net).toBe(2);
    expect(d.compared).toBe(4);
  });

  it("refuses a candidate that gains one, because one is the measured noise", () => {
    // Finding 239 ran one control configuration twice over the same fixtures and recall
    // moved on one of the ten both runs scored. A candidate moving one fixture is
    // therefore indistinguishable from the same playbook run again, and a gate admitting
    // it would accept noise about half the time.
    const scores = [...arm("pv_from", [0, 1, 1, 1]), ...arm("pv_cand", [1, 1, 1, 1])];
    const d = gateCandidate(scores, "pv_from", "pv_cand");
    expect(d.accepted).toBe(false);
    expect(d.net).toBe(1);
    expect(d.reason).toContain("floor");
  });

  it("refuses a candidate that trades one fixture for another", () => {
    const scores = [...arm("pv_from", [1, 0]), ...arm("pv_cand", [0, 1])];
    const d = gateCandidate(scores, "pv_from", "pv_cand");
    expect(d.accepted).toBe(false);
    expect(d.net).toBe(0);
    expect(d.gained).toEqual(["f1"]);
    expect(d.lost).toEqual(["f0"]);
  });

  it("ignores the training half entirely", () => {
    // The number a change is chosen by and the number it is judged by have to be
    // different numbers. A candidate fitted to train must not be able to buy acceptance
    // with train.
    const scores = [
      ...arm("pv_from", [0, 0, 0, 0], "train"),
      ...arm("pv_cand", [1, 1, 1, 1], "train"),
      ...arm("pv_from", [1, 1], "val"),
      ...arm("pv_cand", [1, 1], "val"),
    ];
    const d = gateCandidate(scores, "pv_from", "pv_cand");
    expect(d.accepted).toBe(false);
    expect(d.compared).toBe(2);
    expect(d.net).toBe(0);
  });

  it("counts only fixtures both sides ran", () => {
    // A provider dying halfway through the candidate's arm leaves it with fewer fixtures.
    // Treating the ones it never ran as unchanged — or the ones only it ran as gains —
    // would let a half-finished run look like progress.
    const scores = [...arm("pv_from", [0, 0, 0]), ...arm("pv_cand", [1, 1])];
    const d = gateCandidate(scores, "pv_from", "pv_cand");
    expect(d.compared).toBe(2);
    expect(d.net).toBe(2);
    expect(d.accepted).toBe(true);
  });

  it("decides nothing when the two arms share no fixture", () => {
    const scores = [
      ...arm("pv_from", [1]),
      score({ fixture: "other", playbookVersionId: "pv_cand", recall: 1 }),
    ];
    const d = gateCandidate(scores, "pv_from", "pv_cand");
    expect(d.accepted).toBe(false);
    expect(d.compared).toBe(0);
    expect(d.reason).toContain("nothing to compare");
  });

  it("does not confuse two runs of one version with two versions", () => {
    // `fixtureDeltas` infers its baseline as the most recent *other* version, which is
    // right for a report and wrong here: two runs of one configuration live under one
    // version id, so an inferred baseline compares an arm against itself. Both ids are
    // arguments for that reason.
    const twice = [...arm("pv_from", [0, 0]), ...arm("pv_from", [1, 1])];
    const d = gateCandidate([...twice, ...arm("pv_cand", [1, 1])], "pv_from", "pv_cand");
    // The later run of `pv_from` is the baseline, so the candidate gains nothing.
    expect(d.net).toBe(0);
    expect(d.accepted).toBe(false);
  });
});

describe("rejection memory", () => {
  let db: SqlDatabase;
  let playbookId: string;
  let fromId: string;

  beforeEach(async () => {
    db = await openStore({ path: ":memory:" });
    const published = new PlaybookStore(db).publish(defaultPlaybook(), { activate: true });
    playbookId = published.playbookId;
    fromId = published.id;
  });

  it("hands back what has already been tried, newest first", () => {
    recordAttempt(db, {
      playbookId,
      fromVersionId: fromId,
      edit: { field: "triage.minConfidence", to: 0.9 },
      decision: "rejected",
      reason: "net -1 on held out",
    });
    recordAttempt(db, {
      playbookId,
      fromVersionId: fromId,
      edit: { field: "agents.security.persona", to: "..." },
      decision: "invalid",
      reason: "candidate failed validation",
    });
    // An accepted attempt is history, not a warning, and must not be handed back as one.
    recordAttempt(db, {
      playbookId,
      fromVersionId: fromId,
      edit: { field: "router.budgetTiers", to: [] },
      decision: "accepted",
      reason: "net +2",
    });

    const prior = priorRejections(db, playbookId);
    expect(prior.map((p) => p.decision)).toEqual(["invalid", "rejected"]);
    expect(prior[0]?.edit).toEqual({ field: "agents.security.persona", to: "..." });
  });

  it("is capped, because it goes into a prompt", () => {
    for (let i = 0; i < 30; i++) {
      recordAttempt(db, {
        playbookId,
        fromVersionId: fromId,
        edit: { i },
        decision: "rejected",
        reason: "no",
      });
    }
    expect(priorRejections(db, playbookId)).toHaveLength(20);
    expect(priorRejections(db, playbookId, { limit: 3 })).toHaveLength(3);
  });

  it("survives a row whose edit is not JSON", () => {
    const id = recordAttempt(db, {
      playbookId,
      fromVersionId: fromId,
      edit: { a: 1 },
      decision: "rejected",
      reason: "no",
    });
    db.prepare("UPDATE refinement_attempts SET edit_json='not json' WHERE id=?").run(id);
    expect(priorRejections(db, playbookId)[0]?.edit).toBe("not json");
  });

  it("records the gate's own account of why, not just the verdict", () => {
    const decision = gateCandidate(
      [...arm("pv_from", [1, 0]), ...arm("pv_cand", [0, 1])],
      "pv_from",
      "pv_cand",
    );
    recordAttempt(db, {
      playbookId,
      fromVersionId: fromId,
      edit: {},
      decision: "rejected",
      decisionDetail: decision,
    });
    const row = db
      .prepare("SELECT reason, val_delta_json FROM refinement_attempts")
      .get<{ reason: string; val_delta_json: string }>();
    expect(row?.reason).toBe(decision.reason);
    expect(JSON.parse(row?.val_delta_json ?? "{}").lost).toEqual(["f0"]);
  });
});

describe("where a version came from", () => {
  it("marks a derived version and leaves a human one unmarked", async () => {
    const db = await openStore({ path: ":memory:" });
    const store = new PlaybookStore(db);
    const byHand = store.publish(defaultPlaybook(), { activate: false });
    const derived = store.publish(defaultPlaybook(), { activate: false, createdBy: "refiner" });

    // Read back from the store, not from the return value: the column had been in the
    // schema since the first migration with nothing writing it, and writing it without
    // surfacing it would be the same defect facing the other way.
    expect(store.getVersion(byHand.id)?.createdBy).toBeUndefined();
    expect(store.getVersion(derived.id)?.createdBy).toBe("refiner");
  });
});
