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
    hits,
    misses,
    falsePositives,
    unclassified,
    precision,
    recall,
    costCents: outcome.costCents,
    durationMs: outcome.durationMs,
    agentsRun: outcome.nodes.filter((n) => n.kind === "agent" && n.state === "done").length,
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

export function loadFixtures(dir: string, only?: string): Fixture[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Fixture)
    .filter((f) => !only || f.name === only);
}

export function saveScore(dir: string, score: EvalScore): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${score.fixture}-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify(score, null, 2));
  return path;
}

export function loadScores(dir: string): EvalScore[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as EvalScore);
}

/** Aggregates scores per playbook version so two pipelines can be compared directly. */
export interface VersionComparison {
  playbookVersionId: string;
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
    const key = s.playbookVersionId ?? "unknown";
    byVersion.set(key, [...(byVersion.get(key) ?? []), s]);
  }

  return (
    [...byVersion.entries()]
      .map(([playbookVersionId, runs]) => ({
        playbookVersionId,
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
