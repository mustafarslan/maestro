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

/** First line only — for version strings. Counting anything needs probeLines. */
async function probe(cmd: string, args: string[]): Promise<string | null> {
  const lines = await probeLines(cmd, args);
  return lines === null ? null : (lines[0] ?? "");
}

/**
 * Every line of stdout.
 *
 * Counting leaks needs all of them. `probe()` returns only the first line, and both the
 * stray-container count and the snapshot count were built on it — so a host with forty
 * leaked containers reported "1 leaked container(s)". The magnitude is the entire point
 * of a leak check: an operator sees a number that never grows, concludes there is
 * nothing to clean, and the disk fills anyway.
 */
async function probeLines(cmd: string, args: string[]): Promise<string[] | null> {
  try {
    const { stdout } = await exec(cmd, args, { timeout: 10_000 });
    const trimmed = stdout.trim();
    return trimmed ? trimmed.split("\n") : [];
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
    const out = await probeLines("docker", ["ps", "-aq", "--filter", "label=maestro.managed=true"]);
    const strays = out?.filter(Boolean).length ?? 0;
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

  // Leaked snapshot IMAGES are the disk cost the reaper can hide: stray containers show
  // up in `docker ps` long before the layers behind them do, and the check above counts
  // only containers.
  //
  // Scoped to Maestro's own label, not `docker system df`. A daemon-wide total is
  // dominated by unrelated images and by the non-slim base image every review pulls, so
  // a growing pile of leaked snapshots would not move the number — which is the only
  // thing this line exists to show. Goes through `probe()` like every other external
  // call here, for its 10s timeout: `doctor` is what people run when something is
  // already broken, and a wedged daemon must not hang it with no output.
  if (docker) {
    const all =
      (
        await probeLines("docker", [
          "images",
          "-q",
          "--filter",
          "label=maestro.managed=true",
          "--filter",
          "reference=maestro/snapshot",
        ])
      )?.filter(Boolean) ?? [];
    // Only cache-shared snapshots survive a reap: reap() skips an image whose id is also
    // a cache id and deletes every other labelled snapshot. Reporting all of them as
    // "reap leaves those" would tell an operator to ignore exactly the ones leaking.
    const cacheIds = new Set(
      (await probeLines("docker", ["images", "-q", "maestro/deps"]))?.filter(Boolean) ?? [],
    );
    const leaked = all.filter((id) => !cacheIds.has(id));
    checks.push({
      status: leaked.length === 0 ? "info" : "warn",
      label: "snapshots",
      detail:
        all.length === 0
          ? "no snapshot images"
          : leaked.length === 0
            ? `${all.length} snapshot image(s), all shared with the dependency cache`
            : `${leaked.length} of ${all.length} snapshot image(s) not cache-shared - run 'maestro reap'`,
    });
  }

  console.log(color.bold("\nmaestro doctor\n"));
  for (const c of checks) console.log(checkLine(c.status, c.label, c.detail));

  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const summary = failed ? color.red(`${failed} failed`) : color.green("all checks passed");
  console.log(`\n${summary}${warned ? color.yellow(`, ${warned} warning(s)`) : ""}\n`);
  return failed > 0 ? 1 : 0;
}
