#!/usr/bin/env node
/**
 * The other half of Phase 7's exit criterion, with real containers.
 *
 *   node scripts/crash-recovery-check.mjs ./dist/maestro
 *
 * Builds the state a killed daemon leaves — a review stuck mid-flight and a real
 * container labelled as belonging to it — starts a daemon into it, and checks that the
 * review is recovered and the container collected.
 *
 * SIGKILL cannot be handled, so a crash always leaves containers running; what matters is
 * what the next start does about them. That is the combination this checks. The pieces
 * have unit tests — `recoverStaleReviews` in both directions, the startup sweep against a
 * spy driver — but they had never been run together against Docker, and the startup sweep
 * exists precisely because the periodic one would not have touched these for two hours.
 *
 * The container's age comes from its `maestro.created` label, which is what the reaper
 * reads, so the scenario needs no waiting.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, ReviewStore } from "../packages/core/dist/index.js";

const BINARY = process.argv[2] ?? "./dist/maestro";
const home = mkdtempSync(join(tmpdir(), "maestro-crash-"));
const env = { ...process.env, MAESTRO_HOME: home };
const name = `maestro-crash-orphan-${Date.now()}`;
const fail = (m) => {
  console.log(`  FAIL ${m}`);
  process.exitCode = 1;
};

execFileSync(BINARY, ["init"], { env, stdio: "ignore" });

const db = await openStore({ path: join(home, "maestro.db") });
const reviews = new ReviewStore(db);
const version = db.prepare("SELECT id FROM playbook_versions LIMIT 1").get();
const { id: reviewId } = reviews.create({
  repoOwner: "acme",
  repoName: "web",
  prNumber: 77,
  headSha: "a".repeat(40),
  playbookVersionId: version.id,
});
reviews.setState(reviewId, "analyzing");

// Older than the recovery cutoff, which is deliberately longer than the job lease so a
// review a live worker still holds is never mistaken for an orphan.
const anHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
db.prepare("UPDATE reviews SET created_at=?, started_at=? WHERE id=?").run(
  anHourAgo,
  anHourAgo,
  reviewId,
);

execFileSync(
  "docker",
  [
    "run",
    "-d",
    "--name",
    name,
    "--label",
    "maestro.managed=true",
    "--label",
    `maestro.review=${reviewId}`,
    "--label",
    `maestro.created=${new Date(Date.now() - 3 * 60 * 60_000).toISOString()}`,
    "alpine:latest",
    "sleep",
    "600",
  ],
  { stdio: "ignore" },
);

console.log(`orphaned review ${reviewId} with one running container`);

const daemon = spawn(BINARY, ["serve", "--admin-port", "0"], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
daemon.stdout.on("data", (d) => {
  log += d;
});
daemon.stderr.on("data", (d) => {
  log += d;
});

await new Promise((r) => setTimeout(r, 6000));
daemon.kill("SIGTERM");
await new Promise((r) => daemon.on("exit", r));

const state = db.prepare("SELECT state, error FROM reviews WHERE id=?").get(reviewId);
const containerLeft =
  execFileSync("docker", ["ps", "-aq", "--filter", `name=${name}`], { encoding: "utf8" }).trim() !==
  "";

console.log(`\n  review state     ${state?.state}`);
console.log(`  container        ${containerLeft ? "still running" : "collected"}`);
console.log(
  `  said so          ${log.includes("left behind by a previous process") ? "yes" : "no"}`,
);

if (state?.state !== "failed") fail(`the orphaned review is '${state?.state}', not 'failed'`);
if (containerLeft) fail("its container was not collected by the startup sweep");
if (!log.includes("left behind by a previous process"))
  fail("the restart did not report what it recovered");

execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
if (!process.exitCode) console.log("\nCRASH RECOVERY CHECK PASSED");
