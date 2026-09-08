import { mkdirSync } from "node:fs";
import { dbPath, logsDir, maestroHome, migrate, openStore, workspacesDir } from "@maestro/core";
import { PlaybookStore } from "@maestro/playbook";
import { checkLine, color } from "../ui.js";

/**
 * First-run setup. Deliberately does the filesystem + schema + default-playbook work
 * only; provider keys and the GitHub App flow are added in later phases so that `init`
 * always succeeds offline.
 */
export async function init(): Promise<number> {
  console.log(color.bold("\nmaestro init\n"));

  for (const dir of [maestroHome(), workspacesDir(), logsDir()]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  console.log(checkLine("ok", "directories", maestroHome()));

  const db = await openStore({ migrate: false });
  const state = migrate(db);
  console.log(checkLine("ok", "database", `schema v${state.current} at ${dbPath()}`));

  const record = new PlaybookStore(db).ensureDefault();
  console.log(
    checkLine(
      "ok",
      "playbook",
      `'${record.doc.name}' v${record.version} - ${record.doc.agents.map((a) => a.id).join(", ")}`,
    ),
  );
  db.close();

  console.log(`\n${color.green("ready")}. Next: ${color.cyan("maestro doctor")}\n`);
  return 0;
}
