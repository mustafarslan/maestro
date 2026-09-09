import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import {
  dayAgo,
  dbPath,
  detectRuntime,
  maestroHome,
  migrationState,
  openStore,
  spendSince,
} from "@maestro/core";
import { GitHubClient } from "@maestro/integrations";
import { PRICING_FETCHED_AT } from "@maestro/llm";
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
    // Running containers are not strays. Counting them as leaked told an operator to run
    // `maestro reap` while a review was in flight, and reaping is what destroys it —
    // advice that damages the very thing it claims to diagnose.
    const count = async (args: string[]) =>
      (await probeLines("docker", args))?.filter(Boolean).length ?? 0;
    const all = await count(["ps", "-aq", "--filter", "label=maestro.managed=true"]);
    const live = await count(["ps", "-q", "--filter", "label=maestro.managed=true"]);
    const strays = Math.max(0, all - live);

    checks.push({
      status: strays === 0 ? "ok" : "warn",
      label: "sandboxes",
      detail:
        strays === 0
          ? live === 0
            ? "no strays"
            : `no strays (${live} container(s) in flight)`
          : `${strays} stopped container(s) left behind - run 'maestro reap'` +
            (live ? `; ${live} in flight will be left alone` : ""),
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

  // Whether the GitHub credential works, which nothing checked. A wrong or expired token
  // produced no signal until a review failed several minutes in, having already built a
  // container — and `doctor` is the command people run precisely to avoid that. The
  // identity is worth printing too: reviewing as the wrong account is a configuration
  // mistake that looks like nothing at all.
  const gh = GitHubClient.fromEnv();
  if (!gh) {
    checks.push({
      status: "warn",
      label: "github",
      detail:
        "no credential - set GITHUB_TOKEN, or the GITHUB_APP_* variables. " +
        "'maestro review <local-path>' works without one; pull requests do not",
    });
  } else {
    // Bounded like every other external call here: doctor must not hang on a wedged
    // network when it is being run because something is already broken. The timer is
    // cleared rather than left pending — an unreferenced 10s timeout keeps the event loop
    // alive, so a doctor that answered in 300ms would sit there for another ten seconds.
    let timer: NodeJS.Timeout | undefined;
    const identity = await Promise.race([
      gh.identity().catch((err: unknown) => (err instanceof Error ? `!${err.message}` : "!failed")),
      new Promise<string>((r) => {
        timer = setTimeout(() => r("!timed out after 10s"), 10_000);
      }),
    ]).finally(() => clearTimeout(timer));
    checks.push(
      identity.startsWith("!")
        ? { status: "fail", label: "github", detail: `credential rejected: ${identity.slice(1)}` }
        : { status: "ok", label: "github", detail: `authenticated as ${identity}` },
    );
  }

  // What has actually been spent, against whatever cap is configured. A cap nobody can
  // see the balance of is a cap people find out about by reviews silently stopping.
  try {
    const db2 = await openStore();
    try {
      const caps = new PlaybookStore(db2).getActive("default")?.doc.budget ?? {};
      const spent = spendSince(db2, dayAgo());
      checks.push({
        status:
          caps.dailyCapCents !== undefined && spent >= caps.dailyCapCents
            ? "warn"
            : caps.dailyCapCents !== undefined
              ? "ok"
              : "info",
        label: "spend",
        detail:
          caps.dailyCapCents === undefined
            ? `$${(spent / 100).toFixed(2)} in the last 24h, no daily cap set`
            : `$${(spent / 100).toFixed(2)} of $${(caps.dailyCapCents / 100).toFixed(2)} in the last 24h`,
      });
    } finally {
      db2.close();
    }
  } catch {
    // The database check above already reports a store that cannot be opened; saying it
    // twice adds noise to the thing people run when something is already wrong.
  }

  // Cost figures in every PR comment come from a table cached by hand. Nothing said how
  // old it was, so a number that had drifted looked exactly like a current one.
  const cachedDays = Math.floor(
    (Date.now() - Date.parse(PRICING_FETCHED_AT)) / (24 * 60 * 60 * 1000),
  );
  checks.push({
    status: cachedDays > 180 ? "warn" : "info",
    label: "pricing",
    detail:
      cachedDays > 180
        ? `model prices cached ${cachedDays} days ago (${PRICING_FETCHED_AT}) - costs may be wrong`
        : `model prices cached ${PRICING_FETCHED_AT}`,
  });

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
