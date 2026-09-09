#!/usr/bin/env node
import { logger } from "@maestro/core";
import { doctor } from "./commands/doctor.js";
import { evaluate } from "./commands/evaluate.js";
import { init } from "./commands/init.js";
import { llm } from "./commands/llm.js";
import { mcp } from "./commands/mcp.js";
import { playbook } from "./commands/playbook.js";
import { reap } from "./commands/reap.js";
import { review } from "./commands/review.js";
import { serve } from "./commands/serve.js";
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
  llm <sub>            providers, model catalog, conformance tests, API keys
  playbook <sub>       inspect, export, import and activate playbook versions
  review <target>      review a local checkout or a pull request
  serve                run the daemon: webhooks/poller, workers, admin UI
  mcp                  stdio MCP server for Claude Code
  eval <sub>           score reviews against golden-PR fixtures
  reap                 sweep leaked containers and snapshot images
  version              print the version


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
    case "llm":
      return llm(rest);
    case "playbook":
      return playbook(rest);
    case "reap":
      return reap(rest);
    case "review":
      return review(rest);
    case "serve":
      return serve(rest);
    case "mcp":
      return mcp(rest);
    case "eval":
      return evaluate(rest);
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
