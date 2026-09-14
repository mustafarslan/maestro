import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Finding, severityAtLeast } from "@maestro/agents";
import type { ReviewOutcome } from "./engine.js";

/**
 * Golden-PR evaluation.
 *
 * Prompt and model changes are the highest-frequency edits anyone makes to Maestro, and
 * without this they are guesses. A fixture is a repository state with a known answer key;
 * scoring a run against it turns "this persona feels better" into a number.
 *
 * Results are grouped by playbook version, because comparing runs from different
 * pipelines is meaningless.
 */

/**
 * Which half of the golden set a fixture belongs to.
 *
 * The distinction only matters once something *fits* to these numbers — a refiner
 * proposing persona or graph edits, say — but it has to exist before that, because a
 * split invented after the fact is a split chosen to make a result look good.
 */
export type EvalSplit = "train" | "val";

/**
 * A fixture that does not say is held out.
 *
 * The conservative direction: a fixture silently joining the training set is a fixture
 * whose score stops meaning anything, and nothing would say so. Held out, the worst case
 * is that a training set is smaller than its author intended, which is visible in the
 * report the moment they look.
 */
export const DEFAULT_SPLIT: EvalSplit = "val";

export function splitOf(x: { split?: EvalSplit }): EvalSplit {
  return x.split ?? DEFAULT_SPLIT;
}

export interface ExpectedFinding {
  /** Substring or /regex/ matched against the finding title and body. */
  match: string;
  file?: string;
  /** Optional line window; a finding within tolerance counts as located correctly. */
  line?: number;
  lineTolerance?: number;
  severityAtLeast?: string;
  description?: string;
}

export interface Fixture {
  name: string;
  description?: string;
  /** Local path or a pull request URL. */
  target: string;
  baseRef?: string;
  /** Held out unless it says otherwise. See `DEFAULT_SPLIT`. */
  split?: EvalSplit;
  expected: ExpectedFinding[];
  /** Patterns that must NOT be reported: the false-positive half of the answer key. */
  forbidden?: string[];
}

function matches(pattern: string, finding: Finding): boolean {
  const raw = `${finding.title}\n${finding.body}\n${finding.category}`;
  if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
    const end = pattern.lastIndexOf("/");
    try {
      // Match the ORIGINAL text: lowercasing first would silently defeat any
      // case-sensitive pattern an author deliberately wrote.
      return new RegExp(pattern.slice(1, end), pattern.slice(end + 1) || "i").test(raw);
    } catch {
      return false;
    }
  }
  return raw.toLowerCase().includes(pattern.toLowerCase());
}

function locatedCorrectly(expected: ExpectedFinding, finding: Finding): boolean {
  if (expected.file && finding.file && !finding.file.endsWith(expected.file)) return false;
  if (expected.line !== undefined && finding.lineStart !== undefined) {
    const tolerance = expected.lineTolerance ?? 10;
    if (Math.abs(finding.lineStart - expected.line) > tolerance) return false;
  }
  return true;
}

export interface EvalScore {
  fixture: string;
  playbookVersionId?: string;
  /**
   * The review that produced this score, so a miss can be traced to what the agents actually
   * did (`trajectory_turns`). Absent on scores written before it was recorded: those still
   * compare, they just contribute no trajectory to a refinement round.
   */
  reviewId?: string;
  /**
   * Copied from the fixture at scoring time rather than looked up later, because a
   * fixture's split can be edited and a score is a record of a run that already
   * happened. Absent on scores written before splits existed; readers default it.
   */
  split?: EvalSplit;
  /** Expected findings the run actually reported. */
  hits: { expected: string; matchedTitle: string }[];
  /** Expected findings it missed — these are the recall failures. */
  misses: string[];
  /** Reported findings matching a forbidden pattern: the ones that erode trust. */
  falsePositives: { title: string; pattern: string }[];
  /** Reported findings that were neither expected nor forbidden. */
  unclassified: number;
  /** Undefined when nothing was reported: precision over no predictions is not zero. */
  precision?: number;
  /** Undefined when the fixture expects nothing, as a clean-code fixture does. */
  recall?: number;
  costCents: number;
  durationMs: number;
  agentsRun: number;
  /**
   * When the run was scored. Ordering is what a delta needs and nothing carried it:
   * `readdirSync` makes no promise about order, so "the previous version's score" was
   * whatever the filesystem happened to hand back first.
   */
  recordedAt?: string;
}

export function scoreOutcome(
  fixture: Fixture,
  outcome: ReviewOutcome,
  playbookVersionId?: string,
): EvalScore {
  const reported = outcome.triage?.posted ?? [];

  const hits: EvalScore["hits"] = [];
  const misses: string[] = [];
  const claimed = new Set<Finding>();

  for (const expected of fixture.expected) {
    const found = reported.find(
      (f) =>
        !claimed.has(f) &&
        matches(expected.match, f) &&
        locatedCorrectly(expected, f) &&
        severityOk(expected, f),
    );
    if (found) {
      claimed.add(found);
      hits.push({ expected: expected.match, matchedTitle: found.title });
    } else {
      misses.push(expected.description ?? expected.match);
    }
  }

  const falsePositives: EvalScore["falsePositives"] = [];
  for (const f of reported) {
    if (claimed.has(f)) continue;
    const pattern = (fixture.forbidden ?? []).find((p) => matches(p, f));
    if (pattern) falsePositives.push({ title: f.title, pattern });
  }

  const unclassified = reported.length - claimed.size - falsePositives.length;

  // Unclassified findings count against precision: they may be genuine, but on a fixture
  // with a known answer key they are unverified, and treating them as correct would let
  // a noisy agent score well.
  //
  // Both ratios are UNDEFINED rather than zero when their denominator is empty, because
  // zero is a claim and undefined is the truth. Precision over no predictions said
  // nothing; scoring that 0 makes it indistinguishable from having said two wrong
  // things. Recall over an empty answer key is worse: a clean-code fixture, which exists
  // precisely to check that Maestro stays quiet, scored 0% recall for behaving perfectly
  // — so the one fixture that tests for false positives always looked like total failure.
  const precision = reported.length ? hits.length / reported.length : undefined;
  const recall = fixture.expected.length ? hits.length / fixture.expected.length : undefined;

  return {
    fixture: fixture.name,
    playbookVersionId,
    reviewId: outcome.reviewId,
    split: splitOf(fixture),
    hits,
    misses,
    falsePositives,
    unclassified,
    precision,
    recall,
    costCents: outcome.costCents,
    durationMs: outcome.durationMs,
    agentsRun: outcome.nodes.filter((n) => n.kind === "agent" && n.state === "done").length,
    recordedAt: new Date().toISOString(),
  };
}

function severityOk(expected: ExpectedFinding, finding: Finding): boolean {
  if (!expected.severityAtLeast) return true;
  return severityAtLeast(finding.severity, expected.severityAtLeast);
}

// ── fixture storage ───────────────────────────────────────────────────────────

export function fixturesDir(home: string): string {
  return join(home, "fixtures");
}

/**
 * Where scored runs are written. Beside `fixturesDir` because the two were three
 * separate opinions: the CLI wrote here, and the admin API and MCP server both read
 * `fixturesDir` — so both parsed fixture definitions as scores and `compareVersions`
 * reached `.length` on an absent `falsePositives`. The golden-set panel broke as soon as
 * a fixture existed, which is the only state in which it has anything to show.
 *
 * They also cannot share a directory: `loadFixtures` and `loadScores` each read every
 * `*.json` in the one they are given.
 */
export function scoresDir(home: string): string {
  return join(home, "eval-scores");
}

export function loadFixtures(dir: string, only?: string): Fixture[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Fixture)
    .filter((f) => !only || f.name === only);
}

/**
 * Writes a score, unless no agent completed — in which case there is no score to write.
 *
 * A run where every agent failed reports zero hits and every expected finding missed,
 * which is arithmetically identical to a review that read the diff and found nothing.
 * They are not the same thing and must not be pooled: a provider outage halfway through a
 * twenty-fixture run would otherwise rewrite the baseline as a collapse in recall, and the
 * only trace would be a duration of nine seconds that somebody had to notice. Observed —
 * an account's session quota ran out mid-run and fourteen real results were followed by
 * thirty-four zeroes, all indistinguishable from the real ones inside the score files.
 *
 * Refused here rather than at the call site so it cannot be forgotten by the next caller.
 * Returns the path written, or null when there was nothing worth recording.
 */
export function saveScore(dir: string, score: EvalScore): string | null {
  if (score.agentsRun === 0) return null;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${score.fixture}-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify(score, null, 2));
  return path;
}

/**
 * Scores oldest first.
 *
 * `readdirSync` returns whatever order the filesystem gives — alphabetical on some, and
 * on APFS not reliably anything — so "the newest run" was previously a coin toss. The
 * filename's `Date.now()` is the fallback for scores written before `recordedAt` existed.
 */
export function loadScores(dir: string): EvalScore[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      score: JSON.parse(readFileSync(join(dir, f), "utf8")) as EvalScore,
      fallback: Number(f.match(/-(\d+)\.json$/)?.[1] ?? 0),
    }))
    .sort(
      (a, b) =>
        (a.score.recordedAt ? Date.parse(a.score.recordedAt) : a.fallback) -
        (b.score.recordedAt ? Date.parse(b.score.recordedAt) : b.fallback),
    )
    .map((e) => e.score);
}

/** Aggregates scores per playbook version so two pipelines can be compared directly. */
export interface VersionComparison {
  playbookVersionId: string;
  /**
   * Rows are per (version, split), never pooled across the two.
   *
   * Pooling is the failure this field exists to prevent: the number a change is *chosen*
   * by and the number it is *judged* by have to be different numbers, or the second one
   * measures nothing. A reader who wants one row per version can still filter.
   */
  split: EvalSplit;
  runs: number;
  /** Undefined when nothing was reported: precision over no predictions is not zero. */
  precision?: number;
  /** Undefined when the fixture expects nothing, as a clean-code fixture does. */
  recall?: number;
  falsePositives: number;
  costCents: number;
}

/** Mean of the defined values, or undefined when none are. */
function mean(values: (number | undefined)[]): number | undefined {
  const present = values.filter((v): v is number => v !== undefined);
  return present.length ? present.reduce((a, b) => a + b, 0) / present.length : undefined;
}

export function compareVersions(scores: EvalScore[]): VersionComparison[] {
  const byVersion = new Map<string, EvalScore[]>();
  for (const s of scores) {
    // A tab separates the two halves because neither an id nor a split can contain one,
    // and a delimiter that either could contain silently merges two groups.
    const key = `${s.playbookVersionId ?? "unknown"}\t${splitOf(s)}`;
    byVersion.set(key, [...(byVersion.get(key) ?? []), s]);
  }

  return (
    [...byVersion.entries()]
      .map(([key, runs]) => ({
        playbookVersionId: key.split("\t")[0] as string,
        split: key.split("\t")[1] as EvalSplit,
        runs: runs.length,
        // Averaged over the runs that HAVE a ratio. Folding an undefined in as zero drags
        // a version's score down for fixtures that never asked the question.
        precision: mean(runs.map((r) => r.precision)),
        recall: mean(runs.map((r) => r.recall)),
        falsePositives: runs.reduce((n, r) => n + r.falsePositives.length, 0),
        costCents: runs.reduce((n, r) => n + r.costCents, 0),
      }))
      // A version with no measurable recall sorts last rather than first, which is where
      // `undefined` in a numeric comparison would otherwise leave it.
      .sort((a, b) => (b.recall ?? -1) - (a.recall ?? -1))
  );
}

/**
 * What changed on one fixture between the two most recent playbook versions to run it.
 *
 * Phase 6 asks the persona editor for "test against golden PR … showing the findings
 * delta". Two aggregate percentages do not answer the question a person has after
 * rewriting a persona — *which* defect did it start catching, and what did it stop
 * catching — and a 3% recall movement hides a swap of one finding for another entirely.
 */
export interface FixtureDelta {
  fixture: string;
  /** The fixture's split, so a reader can tell a held-out gain from a fitted one. */
  split: EvalSplit;
  from: string;
  to: string;
  /** Expected findings the newer version caught and the older one missed. */
  gained: string[];
  /** Expected findings the newer version stopped catching. These are the regressions. */
  lost: string[];
  /** Forbidden findings the newer version started reporting. */
  newFalsePositives: string[];
  /** Forbidden findings it stopped reporting. */
  fixedFalsePositives: string[];
  costCentsDelta: number;
}

/**
 * One delta per fixture: its newest score against its newest score from a different
 * playbook version.
 *
 * "A different version" rather than "the previous version" because re-running the same
 * version twice is the ordinary way to check a fixture is stable, and comparing a version
 * against itself would report nothing changed — true, and useless.
 */
export function fixtureDeltas(scores: EvalScore[]): FixtureDelta[] {
  const byFixture = new Map<string, EvalScore[]>();
  for (const s of scores) byFixture.set(s.fixture, [...(byFixture.get(s.fixture) ?? []), s]);

  const deltas: FixtureDelta[] = [];
  for (const [fixture, runs] of byFixture) {
    // loadScores hands these back oldest first.
    const to = runs[runs.length - 1];
    if (!to?.playbookVersionId) continue;
    const from = [...runs]
      .reverse()
      .find((r) => r.playbookVersionId && r.playbookVersionId !== to.playbookVersionId);
    if (!from?.playbookVersionId) continue;

    // Matched against the answer-key entry, not the agent's wording: two versions phrase
    // the same finding differently, and comparing titles would report every run as a
    // total rewrite.
    const hitsOf = (s: EvalScore) => new Set(s.hits.map((h) => h.expected));
    const fpOf = (s: EvalScore) => new Set(s.falsePositives.map((f) => f.pattern));
    const [before, after] = [hitsOf(from), hitsOf(to)];
    const [fpBefore, fpAfter] = [fpOf(from), fpOf(to)];

    deltas.push({
      fixture,
      split: splitOf(to),
      from: from.playbookVersionId,
      to: to.playbookVersionId,
      gained: [...after].filter((h) => !before.has(h)),
      lost: [...before].filter((h) => !after.has(h)),
      newFalsePositives: [...fpAfter].filter((f) => !fpBefore.has(f)),
      fixedFalsePositives: [...fpBefore].filter((f) => !fpAfter.has(f)),
      costCentsDelta: to.costCents - from.costCents,
    });
  }
  return deltas;
}
