import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { openStore, ReviewStore, SpanRecorder } from "@maestro/core";
import { ReviewRecorder, renderReview, runReview } from "@maestro/engine";
import {
  GitHubClient,
  LinearClient,
  parsePullRequestRef,
  reviewPullRequest,
} from "@maestro/integrations";
import { ProviderConfigStore, type ProviderRegistry } from "@maestro/llm";
import { type PlaybookDocument, PlaybookStore } from "@maestro/playbook";
import { DockerSandboxDriver } from "@maestro/sandbox";
import { has, rejectUnknownFlags, wantsHelp } from "../args.js";
import { color } from "../ui.js";

const exec = promisify(execFile);

/**
 * Printing and exiting are separate here for the reason finding 201 records: `usage()` is
 * reached both because somebody asked for help and because somebody got the command
 * wrong, and those are not the same exit code. `review` was the last command still
 * conflating them — it exited 1 on `--help` while the six fixed alongside it exited 0 —
 * because its missing-target path and its help path were the same return.
 */
function printUsage(): void {
  console.log(`
${color.bold("maestro review")} <path | pr-url | owner/repo#123> [options]

  --base <ref>          diff against this ref (local reviews only; default HEAD~1)
  --dry-run             for a pull request, print the review instead of posting it
  --force               re-review a head SHA that has already been reviewed
  --agent <id>          run only this agent (repeatable)
  --provider <id>       override every agent's provider
  --model <id>          override every agent's model
  --json                emit the raw outcome as JSON instead of markdown

Reviews a local checkout: prepares an isolated container, runs the playbook's
agents against it, and prints the consolidated review.

Needs Docker and at least one working provider. The default playbook binds its
agents to Ollama Cloud models, which want ${color.bold("ollama signin")} once; ${color.bold("maestro doctor")}
reports what is missing and ${color.bold("maestro llm test --all")} proves a model answers.
`);
}

function usage(): number {
  printUsage();
  return 1;
}

/**
 * A flag that may be given more than once — `--agent security --agent product`.
 *
 * Both spellings, because `args.ts` opens by promising both and this was the one helper
 * that never got the memo: `--base=main` matched nothing, so the review silently ran
 * against `HEAD~1`, and `--model=x` silently ran the playbook's model. A different review
 * from the one asked for, with no error.
 *
 * `rejectUnknownFlags` made that worse rather than better. It splits on `=` before
 * matching, so `--model=gpt-5` was accepted as a recognised flag — the check said the
 * flag was known while the command ignored it, which is a false guarantee rather than a
 * missing one.
 */
export function args(argv: string[], name: string): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === name && argv[i + 1]) out.push(argv[i + 1] as string);
    else if (a.startsWith(`${name}=`)) out.push(a.slice(name.length + 1));
  });
  return out.filter(Boolean);
}

async function git(cwd: string, gitArgs: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...gitArgs], { maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Refuses before the expensive part when no agent could talk to a model anyway.
 *
 * Preparing an environment clones the repository, installs its dependencies and commits
 * a snapshot image — minutes of real work. Without this, a fresh install with no
 * credentials did all of that and then skipped every agent, because agent nodes are
 * `skip-with-note`: the review completed, reported no findings, and the only sign was
 * the partial-review warning in the comment.
 *
 * Resolution only — no request is made, so this costs nothing and cannot itself fail.
 * A provider that is configured but unreachable still gets past here; `maestro llm test`
 * is what answers that, and the message says so.
 */
export function unresolvableAgents(
  playbook: PlaybookDocument,
  registry: ProviderRegistry,
): { id: string; reason: string }[] {
  const bad: { id: string; reason: string }[] = [];
  for (const agent of playbook.agents) {
    if (!agent.enabled) continue;
    try {
      registry.resolve(agent.model);
    } catch (err) {
      bad.push({ id: agent.id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return bad;
}

/**
 * Turns an interrupt into a clean abort, so the finalizer actually runs.
 *
 * Teardown is a guaranteed finalizer rather than a graph node precisely so that no
 * failure path can leak a container — and it was defeated by the most ordinary thing a
 * person does to a command that is taking a while. `maestro review` had no signal
 * handler, so Ctrl-C killed the process outright and its containers, and the snapshot
 * image behind them, stayed running. Measured: three containers left behind by one
 * interrupted review, still up six minutes later.
 *
 * `serve` had this from the beginning. `review` is the command in the quickstart.
 *
 * A second interrupt exits immediately: somebody pressing Ctrl-C twice means it, and a
 * teardown that is itself wedged must not trap them.
 */
function abortOnInterrupt(): AbortController {
  const controller = new AbortController();
  let interrupted = false;

  const onSignal = (signal: NodeJS.Signals) => {
    if (interrupted) {
      console.error("\ninterrupted again — exiting without waiting for cleanup");
      process.exit(130);
    }
    interrupted = true;
    console.error(`\n${signal} — stopping the review and cleaning up its containers…`);
    controller.abort();
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return controller;
}

export async function review(argv: string[]): Promise<number> {
  rejectUnknownFlags(argv, [
    "--base",
    "--agent",
    "--provider",
    "--model",
    "--json",
    "--dry-run",
    "--force",
  ]);
  const target = argv[0];
  if (wantsHelp(argv)) {
    printUsage();
    return 0;
  }
  if (!target || target.startsWith("--")) return usage();

  const prRef = parsePullRequestRef(target);
  if (!prRef) {
    const asPath = resolve(target);
    if (!existsSync(asPath)) {
      console.error(`no such path, and not a pull request reference: ${target}`);
      return 1;
    }
  }
  const sourcePath = prRef ? "" : resolve(target);

  const baseRef = args(argv, "--base")[0] ?? "HEAD~1";
  const onlyAgents = args(argv, "--agent");
  const providerOverride = args(argv, "--provider")[0];
  const modelOverride = args(argv, "--model")[0];
  const asJson = has(argv, "--json");

  const interrupt = abortOnInterrupt();

  const db = await openStore();
  // Declared out here so the finally removes it even when the review throws.
  let baselineDir: string | undefined;
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
      // A mistyped id would otherwise disable every agent, and the review would complete
      // with no findings — reading as "nothing wrong with your code" rather than "you
      // named an agent that does not exist". Silence that looks like a clean review is
      // the most expensive way to be wrong.
      const known = new Set(playbook.agents.map((a) => a.id));
      const unknown = onlyAgents.filter((id) => !known.has(id));
      if (unknown.length) {
        console.error(
          `unknown agent(s): ${unknown.join(", ")}\n` +
            `this playbook defines: ${[...known].sort().join(", ")}`,
        );
        return 1;
      }
      for (const a of playbook.agents) a.enabled = onlyAgents.includes(a.id);
    }
    // `--agent` works by disabling the others on the pinned copy, so the router reports
    // them as "disabled in playbook" — mechanically true and misleading to read, because
    // the playbook on disk disables nothing. Someone debugging with this flag would go
    // looking for a switch that is not there.
    const filteredOut = new Set(
      onlyAgents.length
        ? playbookRecord.doc.agents.filter((a) => !onlyAgents.includes(a.id)).map((a) => a.id)
        : [],
    );
    for (const a of playbook.agents) {
      if (providerOverride) a.model.providerId = providerOverride;
      if (modelOverride) a.model.model = modelOverride;
    }

    const driverForPr = new DockerSandboxDriver();
    if (prRef) {
      const client = GitHubClient.fromEnv();
      if (!client) {
        console.error(
          "no GitHub credential found. Set GITHUB_TOKEN, or GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY.",
        );
        return 1;
      }
      if (!(await driverForPr.available())) {
        console.error("docker is not available - run 'maestro doctor'");
        return 1;
      }

      const providersPr = new ProviderConfigStore(db);
      providersPr.ensureDefaults();
      const registryPr = await providersPr.buildRegistry();
      if (refuseIfNoAgentCanRun(playbook, registryPr)) return 1;

      console.error(color.dim(`reviewing ${prRef.owner}/${prRef.repo}#${prRef.number}...`));
      const result = await reviewPullRequest({
        client,
        db,
        deps: {
          driver: driverForPr,
          registry: registryPr,
          spans: new SpanRecorder(db),
        },
        playbook,
        playbookVersionId: playbookRecord.id,
        // Undefined unless LINEAR_API_KEY is set; the review runs either way.
        linear: LinearClient.fromEnv(),
        pr: prRef,
        signal: interrupt.signal,
        dryRun: has(argv, "--dry-run"),
        force: has(argv, "--force"),
      });

      if (result.skipped) {
        console.error(color.yellow(`skipped: ${result.skipped}`));
        return 0;
      }
      if (asJson) console.log(JSON.stringify(result.outcome, null, 2));
      else console.log(result.markdown ?? "(no review produced)");
      if (result.posted)
        console.error(color.green(`posted (${result.posted.mode}) #${result.posted.id}`));
      return result.state === "failed" ? 1 : 0;
    }

    const providers = new ProviderConfigStore(db);
    providers.ensureDefaults();
    const registry = await providers.buildRegistry();

    // Before the diff, not after: "no changes since HEAD~1" is a true statement and the
    // wrong thing to tell somebody whose real problem is that no agent can reach a model.
    if (refuseIfNoAgentCanRun(playbook, registry)) return 1;

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

    // A second checkout at the base ref, when the playbook asked for command comparison.
    // This is the cheapest way to exercise the feature — the base is right there on the
    // command line, and no GitHub round trip is involved.
    //
    // Note this path never calls `resolveEnvSpec`, so `trust` stays at the schema default
    // of "trusted". That is correct for a local review of your own checkout; the engine
    // still refuses on `trust` for anything that reaches it downgraded.
    const compareSpec = playbook.envSpec;
    if (compareSpec.compareCommands.length) {
      baselineDir = await materialiseLocalBaseline(sourcePath, baseRef);
      if (!baselineDir) {
        console.error(`cannot check out '${baseRef}' for comparison; skipping base vs head`);
      }
    }

    const outcome = await runReview(
      { driver, registry, spans: new SpanRecorder(db), db },
      {
        reviewId,
        playbook,
        sourcePath,
        baseRef,
        baselinePath: baselineDir,
        changedFiles,
        changedLines,
        context: {
          pr: { title, author },
          diff: { changedFiles, changedLines },
          commands: [],
        },
        // Ctrl-C aborts the run so the finalizer tears its containers down, rather than
        // killing the process and leaving them up.
        signal: interrupt.signal,
      },
    );

    // Said before it is recorded as well as before it is rendered, so the stored trace
    // and the printed report agree about why an agent did not run.
    for (const node of outcome.nodes) {
      if (node.state === "skipped" && node.agentId && filteredOut.has(node.agentId)) {
        node.error = "not selected by --agent";
      }
    }

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
    if (baselineDir) rmSync(baselineDir, { recursive: true, force: true });
  }
}

/**
 * A checkout of `baseRef` beside the working tree, for base-versus-head comparison.
 *
 * `git worktree add` is deliberately not used: its `.git` is a file holding an absolute
 * host path, which is meaningless once the tree has been copied into a container. A plain
 * copy plus a checkout gives a real repository that survives the trip.
 */
async function materialiseLocalBaseline(
  sourcePath: string,
  baseRef: string,
): Promise<string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "maestro-base-"));
  try {
    await exec("cp", ["-R", `${sourcePath}/.`, dir], { maxBuffer: 64 * 1024 * 1024 });
    const run = (args: string[]) =>
      exec("git", ["-C", dir, ...args], { maxBuffer: 64 * 1024 * 1024 });
    await run(["checkout", "--quiet", "--force", baseRef]);
    // Untracked files do not move with a checkout, so without this the head tree's
    // leftovers would be measured as though they were the base. Not `-x`: ignored files
    // are where a local checkout keeps its dependencies.
    await run(["clean", "-fd"]);
    return dir;
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return undefined;
  }
}

/** Prints why nothing could run, and returns true when the caller should stop. */
function refuseIfNoAgentCanRun(playbook: PlaybookDocument, registry: ProviderRegistry): boolean {
  const enabled = playbook.agents.filter((a) => a.enabled);
  const bad = unresolvableAgents(playbook, registry);
  // Some agents resolving is a legitimate partial run; none resolving is not a review.
  if (!enabled.length || bad.length < enabled.length) return false;

  console.error(
    `no agent can reach a model, so this review would prepare an environment and then ` +
      `skip every agent.\n\n` +
      bad.map((b) => `  ${b.id}: ${b.reason}`).join("\n") +
      `\n\nConfigure a provider with 'maestro llm key set <provider>', check what is ` +
      `configured with 'maestro llm providers', and check one really answers with ` +
      `'maestro llm test'.`,
  );
  return true;
}
