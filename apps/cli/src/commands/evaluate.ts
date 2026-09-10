import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { maestroHome, openStore, ReviewStore, SpanRecorder } from "@maestro/core";
import {
  compareVersions,
  type Fixture,
  fixturesDir,
  loadFixtures,
  loadScores,
  ReviewRecorder,
  runReview,
  saveScore,
  scoreOutcome,
  scoresDir,
} from "@maestro/engine";
import { GitHubClient, parsePullRequestRef, reviewPullRequest } from "@maestro/integrations";
import { ProviderConfigStore } from "@maestro/llm";
import { PlaybookStore } from "@maestro/playbook";
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
  run [--fixture <name>]     review each fixture and score it against its answer key
  report                     precision and recall per playbook version

A fixture is a repository state with a known answer key. Scoring against it turns
"this persona feels better" into a number, and groups results by playbook version so
two pipelines can actually be compared.
`);
  return code;
}

export async function evaluate(argv: string[]): Promise<number> {
  rejectUnknownFlags(argv, ["--base", "--fixture"]);
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
      console.log(`    ${f.expected.length} expected, ${f.forbidden?.length ?? 0} forbidden`);
    }
    console.log();
    return 0;
  }

  if (sub === "add") {
    const name = argv[1];
    const target = argv[2];
    if (!name || !target) return usage();
    mkdirSync(dir, { recursive: true });
    const fixture: Fixture = {
      name,
      target: parsePullRequestRef(target) ? target : resolve(target),
      baseRef: arg(argv, "--base"),
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
    console.log(color.bold("\neval report by playbook version\n"));
    for (const v of compareVersions(scores)) {
      console.log(
        `  ${color.cyan(v.playbookVersionId)}  runs=${v.runs}  ` +
          `precision=${pct(v.precision)}  recall=${pct(v.recall)}  ` +
          `false-positives=${v.falsePositives}  cost=${v.costCents.toFixed(2)}c`,
      );
    }
    console.log();
    return 0;
  }

  if (sub !== "run") return usage();

  const only = arg(argv, "--fixture");
  const fixtures = loadFixtures(dir, only);
  if (!fixtures.length) {
    // Distinguish an empty directory from a filter that matched nothing. "No fixtures
    // found in <dir>" sent somebody looking in a directory that had exactly what they
    // asked about, under a different name.
    const all = loadFixtures(dir);
    console.error(
      only && all.length
        ? `no fixture named '${only}'. There ${all.length === 1 ? "is" : "are"} ${all.length}: ` +
            all.map((f) => f.name).join(", ")
        : `no fixtures found in ${dir}`,
    );
    return 1;
  }

  const db = await openStore();
  try {
    const playbookRecord = new PlaybookStore(db).getActive("default");
    if (!playbookRecord) {
      console.error("no active playbook - run 'maestro init'");
      return 1;
    }
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
        `\nevaluating ${fixtures.length} fixture(s) against playbook v${playbookRecord.version}\n`,
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
            changedLines: changedFiles.length * 20,
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
      saveScore(scoresDir(maestroHome()), score);

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
