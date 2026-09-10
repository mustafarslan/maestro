import { IN_FLIGHT_STATES, openStore } from "@maestro/core";
import { DockerSandboxDriver } from "@maestro/sandbox";
import { arg, has, rejectUnknownFlags, wantsHelp } from "../args.js";
import { checkLine, color } from "../ui.js";

/**
 * Sweeps leaked sandboxes.
 *
 * The engine tears down on every terminal state, but a killed process, a Docker daemon
 * restart or a machine that lost power all leave containers and snapshot images behind.
 * Images are where disk actually fills up, so they are swept alongside containers.
 */
export async function reap(argv: string[]): Promise<number> {
  rejectUnknownFlags(argv, ["--all", "--force", "--review"]);
  if (wantsHelp(argv)) {
    console.log(`
${color.bold("maestro reap")} [options]

  --review <id>    only sweep resources belonging to one review
  --all            also remove cached dependency layers (maestro/deps:*)
  --force          include containers belonging to reviews still in flight

Removes Maestro's containers and snapshot images. Cached dependency layers are kept
by default because they are what makes later reviews fast, and containers belonging to
reviews that are still running are left alone unless --force is given.
`);
    return 0;
  }

  const driver = new DockerSandboxDriver();
  if (!(await driver.available())) {
    console.error("docker is not available - nothing to reap");
    return 1;
  }

  // `maestro reap --review` with the id forgotten used to fall through to the UNSCOPED
  // sweep, tearing down every in-flight review's containers. The most destructive action
  // must never be what a typo produces, so the flag being present without a usable value
  // is an error rather than a silent widening.
  const reviewId = arg(argv, "--review");
  if (has(argv, "--review") && !reviewId) {
    console.error("--review requires a review id, e.g. --review rv_1a2b3c");
    return 1;
  }

  console.log(color.bold("\nmaestro reap\n"));

  // A sweep matches every Maestro-labelled container, which includes the ones a running
  // daemon is using right now. Reaping those destroys a review in progress, and `doctor`
  // used to count them as leaked and recommend exactly this command.
  const db = await openStore();
  const active = has(argv, "--force")
    ? []
    : db
        .prepare(
          `SELECT id FROM reviews WHERE state IN (${IN_FLIGHT_STATES.map(() => "?").join(",")})`,
        )
        .all<{ id: string }>(...IN_FLIGHT_STATES)
        .map((r) => r.id);

  const swept = await driver.reap({
    ...(reviewId ? { reviewId } : {}),
    protectReviewIds: active,
  });
  if (swept.protected) {
    console.log(
      checkLine(
        "info",
        "in flight",
        `${swept.protected} container(s) left alone; pass --force to include them`,
      ),
    );
  }
  const sweptAnything = swept.containers > 0 || swept.images > 0;
  console.log(
    checkLine(
      sweptAnything ? "ok" : "info",
      "swept",
      sweptAnything
        ? `${swept.containers} container(s), ${swept.images} image(s)`
        : "nothing to sweep",
    ),
  );

  if (has(argv, "--all")) {
    // Deliberately opt-in: dropping the dependency cache makes the next review of every
    // repository slow again.
    const cached = await driver.reapDependencyCache();
    console.log(checkLine("ok", "cache", `${cached} cached dependency layer(s) removed`));
  }

  // Mark environments the database still believes are alive, so the UI stops showing
  // containers that no longer exist.
  //
  // Leaked rows are stamped rather than rewritten: they keep `state='leaked'`, because
  // that a review could not tear its own containers down is worth remembering, and gain a
  // `destroyed_at` saying this sweep collected them. Excluding them entirely — which is
  // what this did — meant the environments page went on telling an operator to run
  // `maestro reap` after they had run it, about containers that no longer existed.
  try {
    const orphaned = db
      .prepare(
        `UPDATE environments SET state=CASE WHEN state='leaked' THEN 'leaked' ELSE 'destroyed' END,
                                 destroyed_at=?
         WHERE destroyed_at IS NULL${reviewId ? " AND review_id=?" : ""}`,
      )
      .run(...(reviewId ? [new Date().toISOString(), reviewId] : [new Date().toISOString()]));
    if (orphaned.changes) {
      console.log(
        checkLine("ok", "records", `${orphaned.changes} stale environment row(s) closed`),
      );
    }
  } finally {
    db.close();
  }

  console.log();
  return 0;
}
