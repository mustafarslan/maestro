#!/usr/bin/env node
import { logger } from "@maestro/core";
import { doctor } from "./commands/doctor.js";
import { init } from "./commands/init.js";
import { playbook } from "./commands/playbook.js";
import { color } from "./ui.js";

const VERSION = "0.1.0";

function usage(): number {
  console.log(`
${color.bold("maestro")} - multi-agent pull request review

${color.bold("USAGE")}
  maestro <command> [options]

${color.bold("COMMANDS")}
  init                 create ~/.maestro, run migrations, seed the default playbook
  doctor               check runtime, git, docker, database and playbook health
  playbook <sub>       inspect, export, import and activate playbook versions
  version              print the version

${color.dim("Coming in later phases: serve, review, mcp, eval")}
`);
  return 0;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return usage();
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      return 0;
    case "init":
      return init();
    case "doctor":
      return doctor();
    case "playbook":
      return playbook(rest);
    default:
      console.error(`unknown command: ${cmd}\n`);
      usage();
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    logger.error({ err }, "maestro failed");
    console.error(`\n${color.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
