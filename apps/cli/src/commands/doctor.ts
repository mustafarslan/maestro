import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { dbPath, detectRuntime, maestroHome, migrationState, openStore } from "@maestro/core";
import { PlaybookStore, validateGraph } from "@maestro/playbook";
import { checkLine, color } from "../ui.js";

const exec = promisify(execFile);

// "info" is neither pass nor fail: an optional integration being absent is information.
type Status = "ok" | "warn" | "fail" | "info";
interface Check {
  status: Status;
  label: string;
  detail?: string;
}

async function probe(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec(cmd, args, { timeout: 10_000 });
    return stdout.trim().split("\n")[0] ?? "";
  } catch {
    return null;
  }
}

/**
 * `doctor` is the first thing a user runs and the first thing they run when something
 * breaks. It checks what Maestro cannot install for them (Docker, git) and what rots
 * silently (pending migrations, leaked containers, an invalid playbook).
 */
export async function doctor(): Promise<number> {
  const checks: Check[] = [];

  const runtime = detectRuntime();
  const bunVersion = (globalThis as { Bun?: { version: string } }).Bun?.version;
  checks.push({
    status: "ok",
    label: "runtime",
    detail:
      runtime === "bun" ? `bun ${bunVersion} (node ${process.version})` : `node ${process.version}`,
  });

  const homeExists = existsSync(maestroHome());
  checks.push({
    status: homeExists ? "ok" : "warn",
    label: "home",
    detail: homeExists ? maestroHome() : `${maestroHome()} (not created yet - run 'maestro init')`,
  });

  const git = await probe("git", ["--version"]);
  checks.push({ status: git ? "ok" : "fail", label: "git", detail: git ?? "not found on PATH" });

  // Docker is the one external dependency the installer cannot provide.
  const docker = await probe("docker", ["version", "--format", "{{.Server.Version}}"]);
  checks.push({
    status: docker ? "ok" : "fail",
    label: "docker",
    detail: docker
      ? `server ${docker}`
      : "not running or not installed - sandboxes unavailable (https://docs.docker.com/get-docker/)",
  });

  if (docker) {
    const out = await probe("docker", ["ps", "-aq", "--filter", "label=maestro.managed=true"]);
    const strays = out ? out.split("\n").filter(Boolean).length : 0;
    checks.push({
      status: strays === 0 ? "ok" : "warn",
      label: "sandboxes",
      detail: strays === 0 ? "no strays" : `${strays} leaked container(s) - run 'maestro reap'`,
    });
  }

  try {
    const db = await openStore({ migrate: false });
    const state = migrationState(db);
    checks.push({
      status: state.pending.length === 0 ? "ok" : "warn",
      label: "database",
      detail:
        state.pending.length === 0
          ? `schema v${state.current} at ${dbPath()}`
          : `schema v${state.current}, ${state.pending.length} migration(s) pending - run 'maestro init'`,
    });

    if (state.current > 0) {
      const active = new PlaybookStore(db).getActive("default");
      if (!active) {
        checks.push({
          status: "warn",
          label: "playbook",
          detail: "no active playbook - run 'maestro init'",
        });
      } else {
        const issues = validateGraph(active.doc);
        checks.push({
          status: issues.length === 0 ? "ok" : "fail",
          label: "playbook",
          detail:
            issues.length === 0
              ? `'${active.doc.name}' v${active.version} - ${active.doc.agents.length} agents, ${active.doc.graph.nodes.length} nodes`
              : `${issues.length} validation issue(s): ${issues[0]?.message}`,
        });
      }
    }
    db.close();
  } catch (err) {
    checks.push({
      status: "fail",
      label: "database",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // Optional integration: its absence is information, not a problem. Saying nothing at
  // all is worse — a product agent reviewing against no acceptance criteria looks the
  // same as one reviewing against the wrong ones.
  checks.push(
    process.env.LINEAR_API_KEY
      ? {
          status: "ok",
          label: "linear",
          detail: process.env.LINEAR_TEAM_PREFIXES
            ? `issue lookup enabled, prefixes: ${process.env.LINEAR_TEAM_PREFIXES}`
            : "issue lookup enabled",
        }
      : {
          status: "info",
          label: "linear",
          detail: "not configured - set LINEAR_API_KEY to check PRs against their issue",
        },
  );

  console.log(color.bold("\nmaestro doctor\n"));
  for (const c of checks) console.log(checkLine(c.status, c.label, c.detail));

  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const summary = failed ? color.red(`${failed} failed`) : color.green("all checks passed");
  console.log(`\n${summary}${warned ? color.yellow(`, ${warned} warning(s)`) : ""}\n`);
  return failed > 0 ? 1 : 0;
}
