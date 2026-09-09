import { openStore } from "@maestro/core";
import { DockerSandboxDriver } from "@maestro/sandbox";
import { checkLine, color } from "../ui.js";

/**
 * Sweeps leaked sandboxes.
 *
 * The engine tears down on every terminal state, but a killed process, a Docker daemon
 * restart or a machine that lost power all leave containers and snapshot images behind.
 * Images are where disk actually fills up, so they are swept alongside containers.
 */
export async function reap(argv: string[]): Promise<number> {
  if (argv.includes("--help")) {
    console.log(`
${color.bold("maestro reap")} [options]

  --review <id>    only sweep resources belonging to one review
  --all            also remove cached dependency layers (maestro/deps:*)

Removes Maestro's containers and snapshot images. Cached dependency layers are kept
by default because they are what makes later reviews fast.
`);
    return 0;
  }

  const driver = new DockerSandboxDriver();
  if (!(await driver.available())) {
    console.error("docker is not available - nothing to reap");
    return 1;
  }

  const reviewIndex = argv.indexOf("--review");
  const reviewId = reviewIndex >= 0 ? argv[reviewIndex + 1] : undefined;

  console.log(color.bold("\nmaestro reap\n"));
  const swept = await driver.reap(reviewId ? { reviewId } : {});
  console.log(
    checkLine(
      swept.containers || swept.images ? "ok" : "ok",
      "swept",
      `${swept.containers} container(s), ${swept.images} image(s)`,
    ),
  );

  if (argv.includes("--all")) {
    // Deliberately opt-in: dropping the dependency cache makes the next review of every
    // repository slow again.
    const cached = await driver.reapDependencyCache();
    console.log(checkLine("ok", "cache", `${cached} cached dependency layer(s) removed`));
  }

  // Mark environments the database still believes are alive, so the UI stops showing
  // containers that no longer exist.
  const db = await openStore();
  try {
    const orphaned = db
      .prepare(
        `UPDATE environments SET state='destroyed', destroyed_at=?
         WHERE state NOT IN ('destroyed','leaked')${reviewId ? " AND review_id=?" : ""}`,
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
