import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  type EvalScore,
  fixtureDeltas,
  fixturesDir,
  loadFixtures,
  loadScores,
  scoresDir,
} from "./eval.js";

/**
 * Fixtures and scores live in two directories, and every reader must agree on which.
 *
 * They did not. The CLI wrote scores to `~/.maestro/eval-scores` while the admin API and
 * the MCP server read them from `~/.maestro/fixtures` — so both read fixture definitions,
 * parsed them as scores, and `compareVersions` reached `.length` on an absent
 * `falsePositives`. The Quality page's golden-set panel therefore broke the moment a
 * fixture existed, which is the only state in which it has anything to show.
 */
describe("where fixtures and scores live", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "maestro-eval-"));
    mkdirSync(fixturesDir(home), { recursive: true });
    mkdirSync(scoresDir(home), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("keeps them apart", () => {
    expect(scoresDir(home)).not.toBe(fixturesDir(home));
  });

  it("does not read a fixture as a score", () => {
    writeFileSync(
      join(fixturesDir(home), "case.json"),
      JSON.stringify({ name: "case", repo: ".", base: "main", expected: [] }),
    );
    expect(loadScores(scoresDir(home))).toEqual([]);
    // The precise symptom: a fixture parsed as a score has no falsePositives array.
    expect(() => compareVersions(loadScores(scoresDir(home)))).not.toThrow();
  });

  it("does not read a score as a fixture", () => {
    writeFileSync(
      join(scoresDir(home), "case-1.json"),
      JSON.stringify({ fixture: "case", hits: [], misses: [], falsePositives: [] }),
    );
    expect(loadFixtures(fixturesDir(home))).toEqual([]);
  });
});

describe("findings delta between playbook versions", () => {
  const score = (over: Partial<EvalScore>): EvalScore => ({
    fixture: "case",
    hits: [],
    misses: [],
    falsePositives: [],
    unclassified: 0,
    costCents: 0,
    durationMs: 0,
    agentsRun: 1,
    ...over,
  });

  it("names what a version started and stopped catching", () => {
    const deltas = fixtureDeltas([
      score({
        playbookVersionId: "v1",
        hits: [{ expected: "missing-null-check", matchedTitle: "a" }],
        falsePositives: [{ title: "nit", pattern: "style-nit" }],
        costCents: 10,
      }),
      score({
        playbookVersionId: "v2",
        hits: [{ expected: "sql-injection", matchedTitle: "b" }],
        falsePositives: [],
        costCents: 14,
      }),
    ]);

    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      from: "v1",
      to: "v2",
      gained: ["sql-injection"],
      lost: ["missing-null-check"],
      fixedFalsePositives: ["style-nit"],
      newFalsePositives: [],
      costCentsDelta: 4,
    });
  });

  it("matches on the answer-key entry, not the agent's wording", () => {
    // Two versions phrase the same finding differently. Comparing titles would report
    // every run as a total rewrite, which is the same as reporting nothing.
    const deltas = fixtureDeltas([
      score({ playbookVersionId: "v1", hits: [{ expected: "sql-injection", matchedTitle: "x" }] }),
      score({
        playbookVersionId: "v2",
        hits: [{ expected: "sql-injection", matchedTitle: "entirely different words" }],
      }),
    ]);
    expect(deltas[0]).toMatchObject({ gained: [], lost: [] });
  });

  it("says nothing when only one version has ever run the fixture", () => {
    // Two runs of the SAME version is the ordinary way to check a fixture is stable.
    expect(
      fixtureDeltas([
        score({ playbookVersionId: "v1", costCents: 3 }),
        score({ playbookVersionId: "v1", costCents: 4 }),
      ]),
    ).toEqual([]);
  });

  it("compares the newest run against the newest run of a different version", () => {
    const deltas = fixtureDeltas([
      score({ playbookVersionId: "v1", hits: [{ expected: "a", matchedTitle: "a" }] }),
      score({ playbookVersionId: "v2", hits: [] }),
      score({ playbookVersionId: "v2", hits: [{ expected: "a", matchedTitle: "a" }] }),
    ]);
    // The stale v2 run in the middle must not be the one compared.
    expect(deltas[0]).toMatchObject({ from: "v1", to: "v2", gained: [], lost: [] });
  });
});

describe("score ordering", () => {
  let home2: string;
  beforeEach(() => {
    home2 = mkdtempSync(join(tmpdir(), "maestro-order-"));
    mkdirSync(scoresDir(home2), { recursive: true });
  });
  afterEach(() => rmSync(home2, { recursive: true, force: true }));

  it("returns scores oldest first regardless of directory order", () => {
    // Names chosen so alphabetical order is the reverse of chronological order.
    const write = (name: string, recordedAt: string) =>
      writeFileSync(
        join(scoresDir(home2), name),
        JSON.stringify({ fixture: "case", recordedAt, hits: [], falsePositives: [] }),
      );
    write("zzz-1.json", "2026-01-01T00:00:00.000Z");
    write("aaa-2.json", "2026-06-01T00:00:00.000Z");
    expect(loadScores(scoresDir(home2)).map((s) => s.recordedAt)).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
    ]);
  });
});
