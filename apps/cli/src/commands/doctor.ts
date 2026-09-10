import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { promisify } from "node:util";
import {
  checkDisk,
  dayAgo,
  dbPath,
  detectRuntime,
  IN_FLIGHT_STATES,
  MAESTRO_VERSION,
  maestroHome,
  migrationState,
  openStore,
  spendSince,
} from "@maestro/core";
import { GitHubClient, LinearClient, storedGitHubApp } from "@maestro/integrations";
import { PRICING_FETCHED_AT } from "@maestro/llm";
import { PlaybookStore, validateGraph } from "@maestro/playbook";
import {
  classifyContainers,
  listManagedContainers,
  listManagedNetworks,
  resolveProxyBinary,
} from "@maestro/sandbox";
import { checkLine, color } from "../ui.js";

const exec = promisify(execFile);

/**
 * The database file's size, once it is worth mentioning.
 *
 * Nothing here ever deleted anything until `maestro prune` existed, so this grows for the
 * life of the install — roughly a hundred rows per review, dominated by the per-step trace.
 * Silent below 50MB, because a number nobody needs to act on is noise.
 */
function databaseSize(): string {
  try {
    const mb = statSync(dbPath()).size / 1e6;
    if (mb < 50) return "";
    return `, ${mb.toFixed(0)} MB - 'maestro prune' drops the step trace of old reviews`;
  } catch {
    return "";
  }
}

/** `docker images -q` prints one line per tag; the same image can appear several times. */
const uniq = (xs: string[]): string[] => [...new Set(xs)];

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

  try {
    const db = await openStore({ migrate: false });
    const state = migrationState(db);
    checks.push({
      status: state.pending.length === 0 ? "ok" : "warn",
      label: "database",
      detail:
        state.pending.length === 0
          ? `schema v${state.current} at ${dbPath()}${databaseSize()}`
          : `schema v${state.current}, ${state.pending.length} migration(s) pending - run 'maestro init'`,
    });

    if (docker) {
      // Whether a container is a stray is a question about its REVIEW, not its process
      // state.
      //
      // This counted stopped containers as strays and running ones as "in flight". The
      // first version of the check had it the other way round — every managed container was
      // a stray, so `doctor` told an operator to reap while a review was running, and
      // reaping is what destroys it. The correction over-shot: a container left RUNNING by a
      // killed daemon belongs to no live review, holds its memory and its snapshot image,
      // and was reported here as healthy activity. Verified by hand, with a labelled
      // container naming a review that does not exist: "no strays (1 container in flight)".
      //
      // The reaper has always asked the right question — `protectReviewIds` comes from the
      // store — so this now asks the same one through the same listing.
      const managed = await listManagedContainers().catch(() => []);
      const live = new Set(
        db
          .prepare(
            `SELECT id FROM reviews WHERE state IN (${IN_FLIGHT_STATES.map(() => "?").join(",")})`,
          )
          .all<{ id: string }>(...IN_FLIGHT_STATES)
          .map((r) => r.id),
      );
      const { inFlight, strays: strayList } = classifyContainers(managed, live);
      const stillRunning = strayList.filter((c) => c.running).length;
      const strays = strayList.length;

      checks.push({
        status: strays === 0 ? "ok" : "warn",
        label: "sandboxes",
        detail:
          strays === 0
            ? inFlight.length === 0
              ? "no strays"
              : `no strays (${inFlight.length} container(s) in flight)`
            : `${strays} container(s) belong to no running review` +
              (stillRunning ? `, ${stillRunning} of them still running` : "") +
              ` - run 'maestro reap'` +
              (inFlight.length ? `; ${inFlight.length} in flight will be left alone` : ""),
      });

      // Whether the enforced posture can actually start. Checked here because the
      // alternative is finding out at the first review: the prepare phase fails closed,
      // which is right, but "your first review failed" is a worse way to learn that this
      // host has no Linux binary than a line in `doctor`.
      try {
        const binary = await resolveProxyBinary({ version: MAESTRO_VERSION });
        checks.push({
          status: "ok",
          label: "egress proxy",
          detail: `linux binary ready (${binary.source})`,
        });
      } catch (err) {
        checks.push({
          status: "warn",
          label: "egress proxy",
          detail:
            `cannot enforce the prepare-phase allowlist: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` +
            " - run 'pnpm run build:proxy-binary', set MAESTRO_PROXY_BINARY, or set" +
            " egressEnforcement: advisory in the playbook",
        });
      }

      // Networks arrived with enforced egress and are invisible in `docker ps`, so a
      // leaked one is the kind of stray nobody notices until `docker network ls` is
      // hundreds of lines long. Same question as the containers above, asked of the same
      // set of live reviews, so doctor and the reaper cannot disagree about what is
      // garbage.
      const networks = await listManagedNetworks().catch(() => []);
      const strayNetworks = networks.filter((n) => !n.reviewId || !live.has(n.reviewId));
      if (networks.length > 0) {
        checks.push({
          status: strayNetworks.length === 0 ? "ok" : "warn",
          label: "review networks",
          detail:
            strayNetworks.length === 0
              ? `no strays (${networks.length} in flight)`
              : `${strayNetworks.length} network(s) belong to no running review - run 'maestro reap'`,
        });
      }
    }

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
  const storedApp = storedGitHubApp();
  const gh = GitHubClient.fromEnv();
  if (!gh) {
    checks.push({
      status: "warn",
      label: "github",
      detail:
        "no credential - run 'maestro github-app create', or set GITHUB_TOKEN. " +
        "'maestro review <local-path>' works without one; pull requests do not",
    });
  } else if (storedApp && !storedApp.installationId && !process.env.GITHUB_APP_INSTALLATION_ID) {
    // An App with no installation authenticates fine and can reach no repository, which
    // is a state the manifest flow leaves you in by design — the app exists before
    // anybody installs it. Saying "authenticated" here would be true and useless.
    checks.push({
      status: "warn",
      label: "github",
      detail:
        `app ${storedApp.slug ?? storedApp.appId} is created but not installed anywhere - ` +
        `install it at https://github.com/apps/${storedApp.slug ?? ""}/installations/new, ` +
        "then run 'maestro github-app installed'",
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

  // A key that is SET is not a key that works. This said "issue lookup enabled" on the
  // strength of an environment variable existing, and the Linear client degrades
  // gracefully when a call fails — so a wrong or revoked key meant every review quietly
  // ran without ticket context and nothing anywhere said so. Same defect as the GitHub
  // credential, one integration over.
  let linearIdentity = "issue lookup enabled";
  const linear = LinearClient.fromEnv();
  if (linear) {
    let timer: NodeJS.Timeout | undefined;
    const who = await Promise.race([
      linear.identity(),
      new Promise<{ ok: false; reason: string }>((r) => {
        timer = setTimeout(() => r({ ok: false, reason: "timed out after 10s" }), 10_000);
      }),
    ]).finally(() => clearTimeout(timer));
    const prefixes = process.env.LINEAR_TEAM_PREFIXES
      ? `, prefixes: ${process.env.LINEAR_TEAM_PREFIXES}`
      : "";
    linearIdentity = who.ok
      ? `issue lookup enabled as ${who.name}${prefixes}`
      : `LINEAR_API_KEY is set but rejected: ${who.reason}`;
  }

  // Optional integration: its absence is information, not a problem. Saying nothing at
  // all is worse — a product agent reviewing against no acceptance criteria looks the
  // same as one reviewing against the wrong ones.
  checks.push(
    process.env.LINEAR_API_KEY
      ? {
          status: linearIdentity.startsWith("LINEAR_API_KEY is set but rejected") ? "fail" : "ok",
          label: "linear",
          detail: linearIdentity,
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
    // Deduplicated for the same reason the reaper is: `docker images -q` prints a line
    // per tag, and Maestro tags every snapshot twice.
    const all = uniq(
      (
        await probeLines("docker", [
          "images",
          "-q",
          "--filter",
          "label=maestro.managed=true",
          "--filter",
          "reference=maestro/snapshot",
        ])
      )?.filter(Boolean) ?? [],
    );
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

  // Disk, which the daemon now pauses on. Reported here as well because `doctor` is what
  // somebody runs when reviews have stopped, and "the queue is not moving" and "the disk
  // is full" look nothing alike from the outside.
  const disk = checkDisk(maestroHome());
  const gib = (n: number) => `${(n / 1024 ** 3).toFixed(1)}GiB`;
  checks.push(
    !disk.space
      ? { status: "info", label: "disk", detail: "free space could not be read on this filesystem" }
      : disk.ok
        ? {
            status: "ok",
            label: "disk",
            detail: `${gib(disk.space.freeBytes)} free (${(disk.space.freeRatio * 100).toFixed(0)}%) where reviews are prepared`,
          }
        : {
            status: "fail",
            label: "disk",
            detail: `${disk.reason} - the daemon pauses reviews below this; free space or run 'maestro reap'`,
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
