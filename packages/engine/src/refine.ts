import { logger, newId, type SqlDatabase } from "@maestro/core";
import { type EvalScore, type EvalSplit, splitOf } from "./eval.js";

/**
 * The validation gate from arXiv:2609.09153, without the proposer.
 *
 * The paper's loop is: propose an edit, apply it to a copy, verify the copy is structurally
 * valid, score it on a HELD-OUT split, and commit only if `S_val(candidate) >= S_val(current)`
 * — otherwise roll back and remember the rejection so the same edit is not proposed again.
 *
 * What is here is everything except "propose". That half is a model call and needs a
 * provider; building it against a stub would be a claim about something untested. What this
 * module does is make the decision, and the decision is the part Maestro was missing: it has
 * had `compareVersions` and a train/val split for a while and nothing that reads them and
 * acts.
 *
 * Deliberately about playbook FIELDS, not graph topology. `engine.ts` dispatches by node
 * kind and never reads `graph.edges`, so evolving the topology would evolve something
 * nothing executes. Personas, models, router rules and triage thresholds are what changes
 * behaviour, and they are what a candidate edit may touch.
 */

/** How a gate decided, and enough of why to argue with it. */
export interface GateDecision {
  accepted: boolean;
  reason: string;
  /** Fixtures whose recall rose, fell, or stayed, on the held-out half only. */
  gained: string[];
  lost: string[];
  unchanged: string[];
  /** Net fixtures gained. Negative means the candidate lost ground. */
  net: number;
  /** How many held-out fixtures both sides actually ran. A gate over few decides nothing. */
  compared: number;
}

export interface GateOptions {
  /**
   * Fixtures of net gain a candidate must clear. Defaults to 2.
   *
   * Not a taste: `docs/STATUS.md` finding 239 measured the floor by running one control
   * configuration twice over the same twenty fixtures, and recall moved on one of the ten
   * that both runs scored. A candidate that moves one fixture is therefore indistinguishable
   * from the same playbook run twice, and a gate admitting it would be accepting noise half
   * the time. Two is the smallest margin that clears a measured ±1.
   *
   * The paper is explicit that its own accept/reject decisions "turn on one or two episodes
   * and should be read as a search trace rather than as significance tests", at twenty
   * episodes per split. This is ten. The margin is what keeps that honest, and raising the
   * fixture count is what would let it come down.
   */
  minNetGain?: number;
  /** Which half decides. Never `train` in normal use; the parameter exists to be explicit. */
  split?: EvalSplit;
}

/** Per-fixture recall, for one version, on one split. */
function recallByFixture(
  scores: readonly EvalScore[],
  versionId: string,
  split: EvalSplit,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of scores) {
    if (s.playbookVersionId !== versionId || splitOf(s) !== split) continue;
    if (s.recall === undefined || s.recall === null) continue;
    // A fixture run more than once under one version keeps its LAST run, which is the
    // score a person reading the report would see. Scores arrive oldest first.
    out.set(s.fixture, s.recall);
  }
  return out;
}

/**
 * Whether a candidate version may replace the current one.
 *
 * Both version ids are explicit arguments. `fixtureDeltas` infers them — latest score per
 * fixture, most recent *other* version as the baseline — which is right for a report and
 * wrong here: two runs of the same configuration live under one version id, so an inferred
 * baseline silently compared a run against its own arm. That mistake cost a night of
 * measurement, and a gate is the last place to repeat it.
 *
 * Recall, not precision. Finding 239 measured precision moving on four of ten fixtures
 * between identical runs, because the quantity counts every finding the answer key says
 * nothing about; gating on it would be gating on how talkative the model felt.
 */
export function gateCandidate(
  scores: readonly EvalScore[],
  fromVersionId: string,
  candidateVersionId: string,
  opts: GateOptions = {},
): GateDecision {
  const split = opts.split ?? "val";
  const minNetGain = opts.minNetGain ?? 2;

  const before = recallByFixture(scores, fromVersionId, split);
  const after = recallByFixture(scores, candidateVersionId, split);

  const gained: string[] = [];
  const lost: string[] = [];
  const unchanged: string[] = [];
  // Only fixtures BOTH sides ran. A fixture the candidate skipped is not an improvement,
  // and a fixture only the candidate ran has nothing to be an improvement over — counting
  // either would let a half-finished arm look like progress, which is exactly what a
  // provider dying halfway through a run produces.
  for (const [fixture, b] of before) {
    const a = after.get(fixture);
    if (a === undefined) continue;
    if (a > b) gained.push(fixture);
    else if (a < b) lost.push(fixture);
    else unchanged.push(fixture);
  }

  const compared = gained.length + lost.length + unchanged.length;
  const net = gained.length - lost.length;

  if (compared === 0) {
    return {
      accepted: false,
      reason: `nothing to compare: no held-out fixture was scored under both ${fromVersionId} and ${candidateVersionId}`,
      gained,
      lost,
      unchanged,
      net,
      compared,
    };
  }

  const accepted = net >= minNetGain;
  return {
    accepted,
    reason: accepted
      ? `net +${net} fixture(s) on ${compared} held out, clearing the ${minNetGain}-fixture margin`
      : `net ${net >= 0 ? "+" : ""}${net} fixture(s) on ${compared} held out, short of the ` +
        `${minNetGain}-fixture margin the measured run-to-run floor requires`,
    gained,
    lost,
    unchanged,
    net,
    compared,
  };
}

/** One attempt, accepted or not. `rejected` and `invalid` are both negative evidence. */
export interface RefinementAttempt {
  id: string;
  fromVersionId: string;
  candidateVersionId?: string;
  edit: unknown;
  decision: "accepted" | "rejected" | "invalid";
  reason: string;
  createdAt: string;
}

/**
 * Records an attempt, so a later round can be told what has already been tried.
 *
 * This is the paper's third contribution and the cheapest of the three: rejected candidates
 * and their traces are kept and handed back to the refiner as negative evidence, because
 * four of its ten rounds committed nothing and a refiner with no memory will spend the
 * fifth re-proposing the first. Nothing here interprets the edit; it is stored as written.
 */
export function recordAttempt(
  db: SqlDatabase,
  input: {
    playbookId: string;
    fromVersionId: string;
    candidateVersionId?: string;
    edit: unknown;
    decision: RefinementAttempt["decision"];
    decisionDetail?: GateDecision;
    reason?: string;
  },
): string {
  const id = newId("ra");
  const reason = input.reason ?? input.decisionDetail?.reason ?? input.decision;
  db.prepare(
    `INSERT INTO refinement_attempts
       (id, playbook_id, from_version_id, candidate_version_id, edit_json, decision, reason,
        val_delta_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.playbookId,
    input.fromVersionId,
    input.candidateVersionId ?? null,
    JSON.stringify(input.edit),
    input.decision,
    reason,
    input.decisionDetail ? JSON.stringify(input.decisionDetail) : null,
    new Date().toISOString(),
  );
  logger.info(
    { from: input.fromVersionId, decision: input.decision, reason },
    "refinement attempt recorded",
  );
  return id;
}

/**
 * What has already been tried and did not hold, newest first.
 *
 * Capped, because this goes into a prompt: an unbounded history would grow until it
 * crowded out the trajectories it is meant to be read alongside, and the oldest rejection
 * is the least informative thing in it.
 */
export function priorRejections(
  db: SqlDatabase,
  playbookId: string,
  opts: { limit?: number } = {},
): RefinementAttempt[] {
  return db
    .prepare(
      `SELECT id, from_version_id, candidate_version_id, edit_json, decision, reason, created_at
         FROM refinement_attempts
        WHERE playbook_id = ? AND decision IN ('rejected','invalid')
        -- rowid breaks the tie, and the tie is the normal case: a refiner proposing
        -- several edits in one round writes them inside the same millisecond, and
        -- ordering by the timestamp alone then returns them in whatever order SQLite
        -- likes. A promise of "newest first" that holds only when the writes are slow
        -- is not one. (No backticks in this comment: it lives inside a template literal,
        -- and one closed the string and made the whole module fail to parse — which
        -- vitest reports as "no tests", so three mutation checks passed against a file
        -- that did not compile.)
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all<{
      id: string;
      from_version_id: string;
      candidate_version_id: string | null;
      edit_json: string;
      decision: RefinementAttempt["decision"];
      reason: string;
      created_at: string;
    }>(playbookId, opts.limit ?? 20)
    .map((r) => ({
      id: r.id,
      fromVersionId: r.from_version_id,
      candidateVersionId: r.candidate_version_id ?? undefined,
      edit: safeParse(r.edit_json),
      decision: r.decision,
      reason: r.reason,
      createdAt: r.created_at,
    }));
}

/** A row written by an older shape, or by hand, must not throw out of a read. */
function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}
