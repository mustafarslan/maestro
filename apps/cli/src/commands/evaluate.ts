import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { maestroHome, openStore, ReviewStore, SpanRecorder } from "@maestro/core";
import {
  compareVersions,
  type EvalSplit,
  type Fixture,
  fixturesDir,
  gateCandidate,
  loadFixtures,
  loadScores,
  ReviewRecorder,
  runReview,
  saveScore,
  scoreOutcome,
  scoresDir,
  splitOf,
} from "@maestro/engine";
import { GitHubClient, parsePullRequestRef, reviewPullRequest } from "@maestro/integrations";
import { ProviderConfigStore } from "@maestro/llm";
import { PlaybookStore, type PlaybookVersionRecord } from "@maestro/playbook";
import { DockerSandboxDriver } from "@maestro/sandbox";
import { arg, rejectUnknownFlags, wantsHelp } from "../args.js";
import { checkLine, color } from "../ui.js";

/**
 * A ratio, or "n/a" when there was nothing to measure.
 *
 * Rendering an absent ratio as 0% reads as "it got everything wrong" when it means "the
 * question was never asked" — a clean-code fixture, which exists to check that Maestro
 * stays quiet, has no expected findings and so no recall to report.
 */
function pct(value: number | undefined): string {
  return value === undefined ? "n/a" : `${(value * 100).toFixed(0)}%`;
}

const exec = promisify(execFile);

/**
 * `code` is the process exit status, and it is a parameter because this text is printed
 * for two different reasons. Somebody asking `--help` got what they asked for and must
 * see 0; somebody who typed the command wrong must see 1. Returning 1 for both made
 * `maestro playbook --help && ...` fail in a shell, and a CI step that probes a command
 * with `--help` read the tool as broken. `reap` already returned 0 and the others did
 * not, so the two spellings disagreed with each other as well.
 */
function usage(code = 1): number {
  console.log(`
${color.bold("maestro eval")} <subcommand>

  list                       show the fixtures in ~/.maestro/fixtures
  add <name> <target>        register a fixture (a local path or a pull request URL)
    --split train|val        which half of the golden set it belongs to (default val)
  run [--fixture <name>]     review each fixture and score it against its answer key
    --split train|val        run only that half
    --playbook <version-id>  score that version instead of the active default
  report                     precision and recall per playbook version and split
  gate <from-version> <candidate-version>
                             would the candidate replace the current playbook?

A fixture is a repository state with a known answer key. Scoring against it turns
"this persona feels better" into a number, and groups results by playbook version so
two pipelines can actually be compared.

Every fixture is held out unless it says otherwise. The two halves are reported
separately and never pooled: the number a change is chosen by and the number it is
judged by have to be different numbers, or the second one measures nothing.
`);
  return code;
}

/** `--split train|val`, refused rather than silently ignored when it is neither. */
function splitFlag(argv: string[]): EvalSplit | undefined | null {
  const raw = arg(argv, "--split");
  if (raw === undefined) return undefined;
  if (raw === "train" || raw === "val") return raw;
  console.error(`--split must be 'train' or 'val', not '${raw}'`);
  return null;
}

/**
 * Which playbook version a run scores: the one named, else the active default.
 *
 * `--playbook` exists so that measuring a version does not mean activating it. Comparing
 * two pipelines used to be two `playbook activate` calls, which made a measurement change
 * what every other review on this machine would use, and left the wrong one active if the
 * run died between them. The version under measurement is a poor thing for a global
 * setting to be.
 *
 * A function rather than four lines inline, because the guard has to be able to fail: with
 * it inline, a test could only reach the error string, and the error string names the
 * requested version on both branches — so mutating the lookup back to `getActive` left
 * every assertion passing.
 */
export function resolveEvalPlaybook(
  store: Pick<PlaybookStore, "getVersion" | "getActive">,
  wantVersion: string | undefined,
): { record: PlaybookVersionRecord } | { error: string } {
  const record = wantVersion ? store.getVersion(wantVersion) : store.getActive("default");
  if (record) return { record };
  return {
    error: wantVersion
      ? `no playbook version '${wantVersion}'. Run 'maestro playbook versions' to list them.`
      : "no active playbook - run 'maestro init'",
  };
}

export async function evaluate(argv: string[]): Promise<number> {
  rejectUnknownFlags(argv, ["--base", "--fixture", "--playbook", "--split"]);
  const sub = argv[0];
  if (wantsHelp(argv)) return usage(0);
  if (!sub) return usage();

  const dir = fixturesDir(maestroHome());

  if (sub === "list") {
    const fixtures = loadFixtures(dir);
    if (!fixtures.length) {
      console.log(`no fixtures in ${dir}\n\nAdd one: maestro eval add my-case ./path/to/repo`);
      return 1;
    }
    console.log(color.bold("\nfixtures\n"));
    for (const f of fixtures) {
      console.log(`  ${color.cyan(f.name)}  ${color.dim(f.target)}`);
      console.log(
        `    ${splitOf(f)} · ${f.expected.length} expected, ${f.forbidden?.length ?? 0} forbidden`,
      );
    }
    console.log();
    return 0;
  }

  if (sub === "add") {
    const name = argv[1];
    const target = argv[2];
    if (!name || !target) return usage();
    const split = splitFlag(argv);
    if (split === null) return 1;
    mkdirSync(dir, { recursive: true });
    const fixture: Fixture = {
      name,
      target: parsePullRequestRef(target) ? target : resolve(target),
      baseRef: arg(argv, "--base"),
      // Written out even when it is the default, so the file states which half it is in
      // rather than leaving the reader to know what the default happens to be today.
      split: split ?? "val",
      expected: [],
      forbidden: [],
    };
    const path = join(dir, `${name}.json`);
    if (existsSync(path)) {
      console.error(`fixture '${name}' already exists at ${path}`);
      return 1;
    }
    writeFileSync(path, JSON.stringify(fixture, null, 2));
    console.log(checkLine("ok", "created", path));
    console.log(color.dim("\nAdd expected findings to the file, then run 'maestro eval run'.\n"));
    return 0;
  }

  if (sub === "report") {
    const scores = loadScores(scoresDir(maestroHome()));
    if (!scores.length) {
      console.log("no scores yet - run 'maestro eval run'");
      return 1;
    }
    const comparisons = compareVersions(scores);
    console.log(color.bold("\neval report by playbook version\n"));
    // Held out first: it is the number that decides anything, and printing the fitted
    // one above it invites reading the wrong row.
    for (const half of ["val", "train"] as const) {
      const rows = comparisons.filter((c) => c.split === half);
      if (!rows.length) continue;
      console.log(color.bold(`  ${half === "val" ? "held out (val)" : "training (train)"}`));
      for (const v of rows) {
        console.log(
          `    ${color.cyan(v.playbookVersionId)}  runs=${v.runs}  ` +
            `precision=${pct(v.precision)}  recall=${pct(v.recall)}  ` +
            `false-positives=${v.falsePositives}  cost=${v.costCents.toFixed(2)}c`,
        );
      }
    }
    if (!comparisons.some((c) => c.split === "train")) {
      console.log(
        color.dim("\n  No training fixtures yet — every fixture is held out by default."),
      );
    }
    console.log();
    return 0;
  }

  if (sub === "gate") {
    // The decision, printed rather than taken. A refiner that publishes and activates on
    // its own is a bigger step than a gate, and the gate is the part that was missing:
    // `compareVersions` and the train/val split have existed for a while with nothing
    // reading them and acting.
    const [from, candidate] = [argv[1], argv[2]];
    if (!from || !candidate) return usage();
    const scores = loadScores(scoresDir(maestroHome()));
    if (!scores.length) {
      console.error("no scores yet - run 'maestro eval run' for both versions first");
      return 1;
    }
    const d = gateCandidate(scores, from, candidate);
    console.log(color.bold(`\n${d.accepted ? "would accept" : "would reject"}: ${d.reason}\n`));
    for (const [label, list] of [
      ["gained", d.gained],
      ["lost", d.lost],
    ] as const) {
      if (list.length) console.log(`  ${label}: ${list.join(", ")}`);
    }
    console.log(color.dim(`  unchanged: ${d.unchanged.length} of ${d.compared} held out\n`));
    return d.accepted ? 0 : 1;
  }

  if (sub !== "run") return usage();

  const only = arg(argv, "--fixture");
  const wantSplit = splitFlag(argv);
  if (wantSplit === null) return 1;
  const fixtures = loadFixtures(dir, only).filter((f) => !wantSplit || splitOf(f) === wantSplit);
  if (!fixtures.length) {
    // Distinguish an empty directory from a filter that matched nothing. "No fixtures
    // found in <dir>" sent somebody looking in a directory that had exactly what they
    // asked about, under a different name.
    const all = loadFixtures(dir);
    // Three different reasons produce an empty list, and telling somebody "no fixtures
    // found in <dir>" while that directory holds exactly what they asked about — under a
    // different name, or in the other half — is the defect this message already exists
    // to avoid. The split filter had to be added to it rather than around it.
    console.error(
      !all.length
        ? `no fixtures found in ${dir}`
        : only
          ? `no fixture named '${only}'. There ${all.length === 1 ? "is" : "are"} ${all.length}: ` +
            all.map((f) => f.name).join(", ")
          : `no fixtures in the '${wantSplit}' split. ` +
            `${all.filter((f) => splitOf(f) === "val").length} held out, ` +
            `${all.filter((f) => splitOf(f) === "train").length} training.`,
    );
    return 1;
  }

  const db = await openStore();
  try {
    const wantVersion = arg(argv, "--playbook");
    const resolved = resolveEvalPlaybook(new PlaybookStore(db), wantVersion);
    if ("error" in resolved) {
      console.error(resolved.error);
      return 1;
    }
    const playbookRecord = resolved.record;
    const providers = new ProviderConfigStore(db);
    providers.ensureDefaults();
    const registry = await providers.buildRegistry();
    const driver = new DockerSandboxDriver();
    if (!(await driver.available())) {
      console.error("docker is not available - run 'maestro doctor'");
      return 1;
    }

    console.log(
      color.bold(
        `\nevaluating ${fixtures.length} fixture(s) against playbook v${playbookRecord.version}` +
          `${wantVersion ? ` (${playbookRecord.id}, not the active one)` : ""}\n`,
      ),
    );
    let failures = 0;

    for (const fixture of fixtures) {
      const prRef = parsePullRequestRef(fixture.target);
      let outcome: Awaited<ReturnType<typeof runReview>> | undefined;

      if (prRef) {
        const client = GitHubClient.fromEnv();
        if (!client) {
          console.log(checkLine("fail", fixture.name, "needs a GitHub credential"));
          failures++;
          continue;
        }
        const result = await reviewPullRequest({
          client,
          db,
          deps: { driver, registry, spans: new SpanRecorder(db) },
          playbook: playbookRecord.doc,
          playbookVersionId: playbookRecord.id,
          pr: prRef,
          dryRun: true,
          force: true,
          // Always score the whole diff: an incremental round would be measured against
          // an answer key written for the full change.
          incremental: false,
        });
        outcome = result.outcome;
      } else {
        const reviews = new ReviewStore(db);
        const baseRef = fixture.baseRef ?? "HEAD~1";
        const headSha = (
          await exec("git", ["-C", fixture.target, "rev-parse", "HEAD"]).catch(() => ({
            stdout: "unknown",
          }))
        ).stdout.trim();
        const nameOnly = await exec("git", [
          "-C",
          fixture.target,
          "diff",
          "--name-only",
          `${baseRef}...HEAD`,
        ]).catch(() => ({ stdout: "" }));
        const changedFiles = nameOnly.stdout.split("\n").filter(Boolean);

        // Counted, not guessed. This was `changedFiles.length * 20`, which decides the
        // router's budget tier — so a fixture of six small files was scored at a cap
        // production would never have given it, and eval and production quietly ran the
        // same playbook under different budgets. `maestro review` has counted properly
        // all along; this is the same two lines.
        const stat = await exec("git", [
          "-C",
          fixture.target,
          "diff",
          "--shortstat",
          `${baseRef}...HEAD`,
        ]).catch(() => ({ stdout: "" }));
        const changedLines = [...stat.stdout.matchAll(/(\d+) (?:insertion|deletion)/g)].reduce(
          (n, m) => n + Number(m[1]),
          0,
        );

        const { id: reviewId } = reviews.create({
          repoOwner: "eval",
          repoName: fixture.name,
          prNumber: 0,
          headSha: `${headSha}-${Date.now()}`,
          baseRef,
          title: `eval:${fixture.name}`,
          playbookVersionId: playbookRecord.id,
        });

        outcome = await runReview(
          { driver, registry, spans: new SpanRecorder(db), db },
          {
            reviewId,
            playbook: playbookRecord.doc,
            sourcePath: fixture.target,
            baseRef,
            changedFiles,
            changedLines,
            context: { pr: { title: `eval:${fixture.name}` }, diff: { changedFiles } },
          },
        );
        new ReviewRecorder(db).recordOutcome(reviewId, outcome);
        reviews.setState(reviewId, outcome.state, { costCents: outcome.costCents });
      }

      if (!outcome) {
        console.log(checkLine("fail", fixture.name, "no outcome produced"));
        failures++;
        continue;
      }

      const score = scoreOutcome(fixture, outcome, playbookRecord.id);
      const saved = saveScore(scoresDir(maestroHome()), score);

      // No agent completed, so this is an outage and not a result. Reporting it as 0%
      // recall would put a provider's bad afternoon into the golden set's history as a
      // collapse in review quality, which is the number everything else here is judged by.
      if (!saved) {
        failures++;
        console.log(
          checkLine(
            "fail",
            fixture.name,
            `no agent completed - not scored${outcome.error ? `: ${outcome.error}` : ""}`,
          ),
        );
        continue;
      }

      const ok = score.misses.length === 0 && score.falsePositives.length === 0;
      if (!ok) failures++;
      console.log(
        checkLine(
          ok ? "ok" : "warn",
          fixture.name,
          `precision ${pct(score.precision)} recall ${pct(score.recall)}` +
            ` · ${score.hits.length} hit, ${score.misses.length} missed, ${score.falsePositives.length} false-positive` +
            ` · ${(score.durationMs / 1000).toFixed(0)}s`,
        ),
      );
      for (const miss of score.misses) console.log(color.dim(`      missed: ${miss}`));
      for (const fp of score.falsePositives)
        console.log(color.dim(`      false positive: ${fp.title}`));
    }

    console.log(
      failures
        ? color.yellow(`\n${failures} fixture(s) did not fully pass\n`)
        : color.green("\nall fixtures passed\n"),
    );
    return failures ? 1 : 0;
  } finally {
    db.close();
  }
}
