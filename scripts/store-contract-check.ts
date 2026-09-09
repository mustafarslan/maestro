/**
 * The store driver's contract, checked on whichever runtime is executing this.
 *
 * The compiled binary runs `bun:sqlite`; the npm path and every unit test run
 * `node:sqlite`. So the driver the product actually ships was never exercised by the
 * suite — vitest runs on Node, and the two builtins are different implementations behind
 * one interface. A divergence in any of the behaviours below would be invisible until a
 * user hit it, and two of them now carry correctness weight:
 *
 *   - `run().changes`, which is how the idempotency fix distinguishes "I inserted this"
 *     from "somebody else already had" after ON CONFLICT DO NOTHING;
 *   - savepoint nesting, which is what lets `transaction()` compose.
 *
 * Run under both:
 *     node --experimental-strip-types scripts/store-contract-check.ts
 *     bun scripts/store-contract-check.ts
 */
import { openStore } from "../packages/core/dist/index.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
};

const runtime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? "bun" : "node";
console.log(`\nstore driver contract — ${runtime}\n`);

const db = await openStore({ path: ":memory:" });

// ── run().changes ────────────────────────────────────────────────────────────
db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)");
const ins = db.prepare("INSERT INTO t (id, v) VALUES (?, ?) ON CONFLICT(id) DO NOTHING");
const first = ins.run("a", "1");
const second = ins.run("a", "2");
check("changes is a number", typeof first.changes === "number", `got ${typeof first.changes}`);
check("changes is 1 on insert", Number(first.changes) === 1, String(first.changes));
check("changes is 0 on conflict", Number(second.changes) === 0, String(second.changes));
check(
  "the conflicting row did not overwrite",
  db.prepare("SELECT v FROM t WHERE id='a'").get<{ v: string }>()?.v === "1",
);

// ── parameter normalisation ──────────────────────────────────────────────────
db.exec("CREATE TABLE p (b INTEGER, n TEXT, d TEXT)");
db.prepare("INSERT INTO p (b, n, d) VALUES (?, ?, ?)").run(true, undefined, new Date(0));
const row = db.prepare("SELECT b, n, d FROM p").get<{ b: number; n: null; d: string }>();
check("booleans become 1", row?.b === 1, String(row?.b));
check("undefined becomes null", row?.n === null, String(row?.n));
check("Dates become ISO strings", row?.d === new Date(0).toISOString(), String(row?.d));

// ── transactions and savepoints ──────────────────────────────────────────────
db.exec("CREATE TABLE tx (v TEXT)");
db.transaction(() => {
  db.prepare("INSERT INTO tx (v) VALUES ('outer')").run();
  try {
    db.transaction(() => {
      db.prepare("INSERT INTO tx (v) VALUES ('inner')").run();
      throw new Error("roll the savepoint back");
    });
  } catch {
    // expected: the inner savepoint rolls back, the outer transaction continues
  }
});
const kept = db
  .prepare("SELECT v FROM tx")
  .all<{ v: string }>()
  .map((r) => r.v);
check(
  "a nested failure rolls back only the savepoint",
  JSON.stringify(kept) === '["outer"]',
  JSON.stringify(kept),
);

// ── read shapes ──────────────────────────────────────────────────────────────
check(
  "get returns undefined for no row",
  db.prepare("SELECT v FROM tx WHERE v='nope'").get() === undefined,
);
check(
  "all returns an empty array for no rows",
  JSON.stringify(db.prepare("SELECT v FROM tx WHERE v='nope'").all()) === "[]",
);

db.close();
console.log(
  failures
    ? `\n${failures} failed on ${runtime}\n`
    : `\nall contract checks passed on ${runtime}\n`,
);
process.exit(failures ? 1 : 0);
