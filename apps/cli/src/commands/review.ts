import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { openStore, ReviewStore, SpanRecorder } from "@maestro/core";
import { ReviewRecorder, renderReview, runReview } from "@maestro/engine";
import { ProviderConfigStore } from "@maestro/llm";
import { PlaybookStore } from "@maestro/playbook";
import { DockerSandboxDriver } from "@maestro/sandbox";
import { color } from "../ui.js";

const exec = promisify(execFile);

function usage(): number {
  console.log(`
${color.bold("maestro review")} <path> [options]

  --base <ref>          diff against this ref (default: HEAD~1)
  --agent <id>          run only this agent (repeatable)
  --provider <id>       override every agent's provider
  --model <id>          override every agent's model
  --json                emit the raw outcome as JSON instead of markdown

Reviews a local checkout: prepares an isolated container, runs the playbook's
agents against it, and prints the consolidated review.
`);
  return 1;
}

function args(argv: string[], name: string): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === name && argv[i + 1]) out.push(argv[i + 1] as string);
  });
  return out;
}

async function git(cwd: string, gitArgs: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...gitArgs], { maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

export async function review(argv: string[]): Promise<number> {
  const target = argv[0];
  if (!target || target.startsWith("--")) return usage();

  const sourcePath = resolve(target);
  if (!existsSync(sourcePath)) {
    console.error(`no such path: ${sourcePath}`);
    return 1;
  }

  const baseRef = args(argv, "--base")[0] ?? "HEAD~1";
  const onlyAgents = args(argv, "--agent");
  const providerOverride = args(argv, "--provider")[0];
  const modelOverride = args(argv, "--model")[0];
  const asJson = argv.includes("--json");

  const db = await openStore();
  try {
    const playbookRecord = new PlaybookStore(db).getActive("default");
    if (!playbookRecord) {
      console.error("no active playbook - run 'maestro init'");
      return 1;
    }
    const playbook = structuredClone(playbookRecord.doc);

    // Overrides are applied to the pinned copy only; the stored playbook is untouched,
    // so a one-off `--model` never mutates configuration.
    if (onlyAgents.length) {
      for (const a of playbook.agents) a.enabled = onlyAgents.includes(a.id);
    }
    for (const a of playbook.agents) {
      if (providerOverride) a.model.providerId = providerOverride;
      if (modelOverride) a.model.model = modelOverride;
    }

    let changedFiles: string[] = [];
    let changedLines = 0;
    try {
      const nameOnly = await git(sourcePath, ["diff", "--name-only", `${baseRef}...HEAD`]);
      changedFiles = nameOnly.split("\n").filter(Boolean);
      const stat = await git(sourcePath, ["diff", "--shortstat", `${baseRef}...HEAD`]);
      changedLines = [...stat.matchAll(/(\d+) (?:insertion|deletion)/g)].reduce(
        (n, m) => n + Number(m[1]),
        0,
      );
    } catch (err) {
      console.error(
        `cannot diff against '${baseRef}': ${err instanceof Error ? err.message : err}`,
      );
      return 1;
    }
    if (!changedFiles.length) {
      console.error(`no changes between ${baseRef} and HEAD`);
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

    const title = await git(sourcePath, ["log", "-1", "--format=%s"]).catch(() => "local review");
    const author = await git(sourcePath, ["log", "-1", "--format=%an"]).catch(() => undefined);
    const headSha = await git(sourcePath, ["rev-parse", "HEAD"]).catch(() => "unknown");

    // A local review is still a real review row: spans, tasks and findings all hang off
    // it, and it pins the playbook version so the run stays explainable afterwards.
    const reviews = new ReviewStore(db);
    const { id: reviewId } = reviews.create({
      repoOwner: "local",
      repoName: basename(sourcePath),
      prNumber: 0,
      headSha,
      baseRef,
      title,
      author,
      playbookVersionId: playbookRecord.id,
    });
    reviews.setState(reviewId, "preparing");

    console.error(
      color.dim(
        `reviewing ${sourcePath} (${changedFiles.length} files, ~${changedLines} lines) against ${baseRef}...`,
      ),
    );

    const outcome = await runReview(
      { driver, registry, spans: new SpanRecorder(db), db },
      {
        reviewId,
        playbook,
        sourcePath,
        baseRef,
        changedFiles,
        changedLines,
        context: {
          pr: { title, author },
          diff: { changedFiles, changedLines },
          commands: [],
        },
      },
    );

    new ReviewRecorder(db).recordOutcome(reviewId, outcome);
    reviews.setState(reviewId, outcome.state, {
      error: outcome.error,
      costCents: outcome.costCents,
    });

    if (asJson) console.log(JSON.stringify(outcome, null, 2));
    else console.log(renderReview(outcome, { title: `Maestro review — ${title}` }));

    return outcome.state === "failed" ? 1 : 0;
  } finally {
    db.close();
  }
}
