#!/usr/bin/env node
import { execFileSync } from "node:child_process";
/**
 * Phase 7's exit criterion, with real containers.
 *
 *   node scripts/load-check.mjs [reviews] [repos]
 *
 * Ten reviews across three repositories, run concurrently through the real graph
 * interpreter and the real Docker driver, under the real scheduler. What it asserts is
 * what the phase actually promises: every review completes, the concurrency limits hold,
 * and nothing is left behind.
 *
 * The provider is a stub. The load scenario is about containers, admission and teardown —
 * not about what a model says — and forty real agent runs would cost money and an hour to
 * tell us nothing about any of those three. Every container, image and volume here is
 * real.
 *
 * Imports from `dist` by relative path, like the other scripts here, so it runs under
 * plain `node` with no workspace resolution. Build first.
 *
 * Deliberately NOT part of the gate: it starts dozens of containers and takes minutes.
 * It is a thing you run when you mean to.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, ReviewStore, SpanRecorder } from "../packages/core/dist/index.js";
import { runReview } from "../packages/engine/dist/index.js";
import { anthropicTransport, fakeConfig, ProviderRegistry } from "../packages/llm/dist/index.js";
import { defaultPlaybook, EnvSpecSchema, PlaybookStore } from "../packages/playbook/dist/index.js";
import { DockerSandboxDriver } from "../packages/sandbox/dist/index.js";
import { DEFAULT_LIMITS, Scheduler } from "../packages/server/dist/index.js";

const REVIEWS = Number(process.argv[2] ?? 10);
const REPOS = Number(process.argv[3] ?? 3);

const driver = new DockerSandboxDriver();
if (!(await driver.available())) {
  console.error("docker is not available");
  process.exit(1);
}

const registry = new ProviderRegistry();
registry.register(
  fakeConfig(
    anthropicTransport([
      { toolCalls: [{ id: "1", name: "submit_findings", input: { findings: [] } }] },
    ]),
    { id: "anthropic" },
  ),
);

/** A small real repository per "repo", so each review has something to check out. */
const repoDirs = Array.from({ length: REPOS }, (_, i) => {
  const dir = mkdtempSync(join(tmpdir(), `maestro-load-${i}-`));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: `fixture-${i}`, version: "1.0.0" }),
  );
  writeFileSync(join(dir, "index.js"), `module.exports = ${i};\n`);
  const git = (args) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  execFileSync("git", ["init", "--quiet", "-b", "main", dir], { stdio: "ignore" });
  git(["config", "user.email", "load@example.com"]);
  git(["config", "user.name", "Load"]);
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "base"]);
  writeFileSync(join(dir, "index.js"), `module.exports = ${i} + 1;\n`);
  git(["commit", "--quiet", "-am", "change"]);
  return dir;
});

// Small on purpose: the machine is running up to `global` of these at once, and the
// question is whether admission and teardown hold, not whether an agent has room to build.
const spec = EnvSpecSchema.parse({
  image: "node:22-bookworm",
  cpus: 1,
  memory: "512MiB",
  timeouts: { prepareSec: 300, analyzeSec: 300, commandSec: 60 },
  setup: [],
  allowedCommands: [],
  egressAllowlist: [],
});

// A real store with real review rows: the recorder writes spans, tasks and findings
// against them, so this also puts ten concurrent reviews through one SQLite file, which
// is its own thing worth knowing holds.
const db = await openStore({
  path: join(mkdtempSync(join(tmpdir(), "maestro-load-db-")), "load.db"),
});
const version = new PlaybookStore(db).publish(defaultPlaybook());
const reviews = new ReviewStore(db);
const reviewIds = Array.from(
  { length: REVIEWS },
  (_, i) =>
    reviews.create({
      repoOwner: "load",
      repoName: `repo-${i % REPOS}`,
      prNumber: i,
      headSha: String(i).padStart(40, "0"),
      playbookVersionId: version.id,
    }).id,
);

const scheduler = new Scheduler(DEFAULT_LIMITS);

let live = 0;
let peak = 0;
const acquireSlot = async (req, signal) => {
  const release = await scheduler.acquire(req, signal);
  live++;
  peak = Math.max(peak, live);
  return () => {
    live--;
    release();
  };
};

const managed = () =>
  execFileSync("docker", ["ps", "-aq", "--filter", "label=maestro.managed=true"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean).length;

const before = managed();
console.log(
  `starting ${REVIEWS} reviews across ${REPOS} repositories (${before} managed container(s) already present)`,
);
const started = Date.now();

const outcomes = await Promise.all(
  Array.from({ length: REVIEWS }, (_, i) =>
    runReview(
      { driver, registry, db, spans: new SpanRecorder(db), acquireSlot },
      {
        reviewId: reviewIds[i],
        repoId: `repo-${i % REPOS}`,
        playbook: defaultPlaybook(),
        sourcePath: repoDirs[i % REPOS],
        baseRef: "HEAD~1",
        changedFiles: ["index.js"],
        changedLines: 1,
        context: { pr: { number: i, title: `load ${i}` } },
        envSpec: spec,
      },
    ).catch((err) => ({ state: "threw", error: String(err) })),
  ),
);

const seconds = ((Date.now() - started) / 1000).toFixed(1);
const done = outcomes.filter((o) => o.state === "done").length;
const other = outcomes.filter((o) => o.state !== "done");
const after = managed();

console.log(`\n  completed        ${done}/${REVIEWS} in ${seconds}s`);
console.log(`  peak concurrent  ${peak} agent slot(s) (limit ${DEFAULT_LIMITS.global})`);
console.log(`  containers       ${before} before, ${after} after`);
console.log(`  scheduler        ${scheduler.trackedReviews()} review(s) still tracked`);
for (const o of other) console.log(`  NOT DONE         ${o.state} ${o.error ?? ""}`);

const failures = [];
if (done !== REVIEWS) failures.push(`${REVIEWS - done} review(s) did not complete`);
if (peak > DEFAULT_LIMITS.global)
  failures.push(`peak concurrency ${peak} exceeded the limit of ${DEFAULT_LIMITS.global}`);
if (after > before) failures.push(`${after - before} container(s) leaked`);
if (scheduler.trackedReviews() !== 0)
  failures.push(`${scheduler.trackedReviews()} review(s) leaked a fairness tally`);

console.log();
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
console.log("LOAD CHECK PASSED");
