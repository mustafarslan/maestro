#!/usr/bin/env node
/**
 * Two workers must never claim the same job.
 *
 * A review that runs twice posts twice, spends twice, and starts two sets of containers.
 * `claim` guards against that with `BEGIN IMMEDIATE`, and a single-process test cannot
 * exercise it: the property only exists when separate processes contend for the same
 * SQLite file, which is exactly how the daemon runs its workers.
 *
 * Also covers the write path underneath — WAL, `busy_timeout`, `foreign_keys` — since
 * every claim is a transaction against a file five processes are writing at once.
 *
 *   pnpm build && node scripts/queue-race-check.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKERS = 5;
const JOBS = 200;
const dir = mkdtempSync(join(tmpdir(), "maestro-queue-race-"));
const dbPath = join(dir, "race.db");
const out = join(dir, "claims.txt");
const core = new URL("../packages/core/dist/index.js", import.meta.url).href;

const worker = join(dir, "worker.mjs");
writeFileSync(
  worker,
  `import { openStore, JobQueue } from ${JSON.stringify(core)};
import { appendFileSync } from "node:fs";
const [, , dbPath, label, out] = process.argv;
const db = await openStore({ path: dbPath });
const q = new JobQueue(db, label);
// A pause between claims so the workers interleave. Without it the first process to start
// drains the queue and the race never happens — which is what the first version of this
// check did, and it proved only that one worker can empty a queue.
for (let i = 0; i < ${Math.ceil((JOBS / WORKERS) * 1.5)}; i++) {
  const job = q.claim(60_000, ["race"]);
  if (job) appendFileSync(out, job.id + "\\n");
  await new Promise((r) => setTimeout(r, 1));
}
db.close();
`,
);

try {
  const { openStore, JobQueue } = await import(core);
  const db = await openStore({ path: dbPath });
  const q = new JobQueue(db, "seed");
  for (let i = 0; i < JOBS; i++) q.enqueue({ kind: "race", payload: { i }, dedupeKey: `k${i}` });
  db.close();

  const running = [];
  for (let i = 0; i < WORKERS; i++) {
    running.push(
      new Promise((resolve) => {
        const r = spawnSync(process.execPath, [worker, dbPath, `w${i}`, out], { encoding: "utf8" });
        resolve(r.status);
      }),
    );
  }
  const statuses = await Promise.all(running);

  const claims = readFileSync(out, "utf8").split("\n").filter(Boolean);
  const distinct = new Set(claims);
  const duplicates = claims.length - distinct.size;

  let failures = 0;
  const check = (name, ok, detail) => {
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
    if (!ok) failures++;
  };

  console.log(`\nqueue claim race — ${WORKERS} processes, ${JOBS} jobs\n`);
  check(
    "every worker exited cleanly",
    statuses.every((s) => s === 0),
    statuses.join(","),
  );
  check("no job was claimed twice", duplicates === 0, `${duplicates} duplicate claim(s)`);
  check("every job was claimed", distinct.size === JOBS, `${distinct.size}/${JOBS}`);
  // If one process took everything, the workers never contended and the check proved
  // nothing about the race it exists for.
  check("the workers actually contended", claims.length >= JOBS, `${claims.length} claims`);

  console.log(
    failures ? `\n${failures} failed\n` : "\nqueue claim is safe under real contention\n",
  );
  process.exit(failures ? 1 : 0);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
