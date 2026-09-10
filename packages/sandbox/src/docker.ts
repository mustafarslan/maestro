import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Logger, logger, MAESTRO_VERSION, newId } from "@maestro/core";
import type { EgressEnforcement, EnvSpec } from "@maestro/playbook";
import { dependencyCacheKey, mayWriteCache, snapshotTag } from "./cache.js";
import {
  PROXY_LOG_PATH,
  PROXY_READY_PATH,
  runningInContainer,
  startEgressProxy,
} from "./egress-proxy.js";
import { resolveProxyBinary } from "./proxy-binary.js";
import { detectedCommands, detectToolchain, expandAuto } from "./toolchain.js";
import type {
  ExecResult,
  PreparedEnvironment,
  PrepareRequest,
  Sandbox,
  SandboxDriver,
} from "./types.js";

export const LABEL_MANAGED = "maestro.managed";
export const LABEL_REVIEW = "maestro.review";
export const LABEL_CREATED = "maestro.created";

const WORKDIR = "/work";
/** Caches must live somewhere writable, because the analyze rootfs is read-only. */
const CACHE_DIR = "/tmp/maestro-cache";

/**
 * Where corepack keeps the package-manager binary it downloads.
 *
 * Deliberately NOT under CACHE_DIR. The analyze phase mounts a tmpfs over `/tmp`, which
 * shadows everything the prepare phase baked in there — so a package manager downloaded
 * during prepare was invisible by the time an agent tried to use it, and every
 * allowlisted command died in 0.1s trying to fetch it with no network. Outside `/tmp`
 * the download survives `docker commit` and is simply read from the read-only rootfs.
 */
const COREPACK_HOME = "/opt/maestro-corepack";

interface RunOptions {
  timeoutMs: number;
  input?: string;
  signal?: AbortSignal;
  /** Cap captured output; a runaway build can emit tens of MB. */
  maxOutputBytes?: number;
}

const DEFAULT_MAX_OUTPUT = 512 * 1024;

async function docker(args: string[], opts: Partial<RunOptions> = {}): Promise<ExecResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  // Checked before spawning, not only listened for. An `abort` event fires once, at abort
  // time — adding a listener to a signal that has already aborted never fires it, which is
  // Node's documented behaviour and easy to confirm. So every docker command started after
  // a review was cancelled ran to completion: the whole point of cancel-on-push is that
  // the containers stop, and each subsequent pull, run, commit and copy went ahead
  // regardless, holding exactly the resources the cancellation was meant to release.
  if (opts.signal?.aborted) {
    return {
      command: `docker ${args.join(" ")}`,
      exitCode: 130,
      stdout: "",
      stderr: "cancelled before the command started",
      durationMs: 0,
      timedOut: false,
      aborted: true,
    };
  }

  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let outBytes = 0;
    let timedOut = false;
    let aborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d: Buffer) => {
      outBytes += d.length;
      if (outBytes <= maxBytes) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < maxBytes) stderr += d.toString();
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();

    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (outBytes > maxBytes) {
        stdout += `\n... [output truncated: ${outBytes} bytes total, showing first ${maxBytes}]`;
      }
      resolve({
        command: `docker ${args.join(" ")}`,
        // 124 is the timeout convention and 130 is "terminated by the operator"; a
        // cancelled command reported 124, so a review cancelled by a push looked to
        // everyone downstream like the repository's build had hung.
        exitCode: aborted ? 130 : timedOut ? 124 : (code ?? 1),
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        aborted,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        command: `docker ${args.join(" ")}`,
        exitCode: 127,
        stdout: "",
        stderr: err.message,
        durationMs: Date.now() - started,
        timedOut: false,
      });
    });
  });
}

function parseMemory(value: string): string {
  // Docker wants "4g"/"512m"; the playbook writes "4GiB"/"512MiB".
  const m = /^(\d+(?:\.\d+)?)\s*([kKmMgG])?i?[bB]?$/.exec(value.trim());
  if (!m) return "2g";
  return `${m[1]}${(m[2] ?? "g").toLowerCase()}`;
}

export class DockerSandboxDriver implements SandboxDriver {
  readonly name = "docker";

  async available(): Promise<boolean> {
    const res = await docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 10_000 });
    return res.exitCode === 0;
  }

  async prepare(req: PrepareRequest): Promise<PreparedEnvironment> {
    const { spec, reviewId } = req;
    const id = newId("env");
    const log = logger.child({ reviewId, envId: id });

    const snapshot = await snapshotOfDirectory(req.sourcePath);
    const toolchain = detectToolchain(snapshot);
    const image = spec.image === "auto" ? toolchain.image : spec.image;
    const setup = expandAuto(spec.setup, toolchain.setup);
    const allowedCommands = expandAuto(spec.allowedCommands, detectedCommands(toolchain));

    log.info({ toolchain: toolchain.kind, image, setup, allowedCommands }, "preparing environment");

    // Installing dependencies dominates a review's wall clock. When the lockfile, base
    // image and setup commands are all unchanged, the previous dependency layer is
    // reusable and the prepare phase drops to near zero.
    const cacheKey = dependencyCacheKey({ sourcePath: req.sourcePath, image, setup, toolchain });
    const cachedTag = cacheKey ? snapshotTag(cacheKey) : null;
    if (cachedTag) {
      const hit = await docker(["image", "inspect", cachedTag], { timeoutMs: 20_000 });
      if (hit.exitCode === 0) {
        log.info({ cachedTag }, "dependency cache hit; skipping install");
        const refreshed = await refreshCheckout(cachedTag, req, spec, id, reviewId);
        if (refreshed) {
          return {
            id,
            reviewId,
            imageId: refreshed,
            toolchain,
            allowedCommands,
            setupResults: [],
            egressLog: [],
            cacheHit: true,
          };
        }
        log.warn({ cachedTag }, "cache hit but refresh failed; falling back to a full install");
      }
    }

    const pull = await docker(["pull", image], { timeoutMs: spec.timeouts.prepareSec * 1000 });
    if (pull.exitCode !== 0 && !pull.stderr.includes("up to date")) {
      log.warn({ stderr: pull.stderr.slice(0, 500) }, "image pull failed; trying local image");
    }

    // Network for the prepare phase goes through an allowlist proxy — nothing else.
    const proxy = await startPreparePhaseProxy({ spec, reviewId, id, log });
    const containerId = `maestro-prep-${id}`;

    try {
      const proxyUrl = proxy.url;

      const create = await docker(
        [
          "create",
          "--name",
          containerId,
          "--label",
          `${LABEL_MANAGED}=true`,
          "--label",
          `${LABEL_REVIEW}=${reviewId}`,
          "--label",
          `${LABEL_CREATED}=${new Date().toISOString()}`,
          ...proxy.containerArgs,
          "--memory",
          parseMemory(spec.memory),
          "--cpus",
          String(spec.cpus),
          "--pids-limit",
          String(spec.pids),
          "--security-opt",
          "no-new-privileges",
          // Proxy vars are the ONLY route out; the container has no direct egress path
          // it can use without them for the package managers we drive.
          "--env",
          `HTTP_PROXY=${proxyUrl}`,
          "--env",
          `HTTPS_PROXY=${proxyUrl}`,
          "--env",
          `http_proxy=${proxyUrl}`,
          "--env",
          `https_proxy=${proxyUrl}`,
          "--env",
          "NO_PROXY=localhost,127.0.0.1",
          "--env",
          `npm_config_cache=${CACHE_DIR}/npm`,
          "--env",
          `XDG_CACHE_HOME=${CACHE_DIR}`,
          "--env",
          `COREPACK_HOME=${COREPACK_HOME}`,
          "--workdir",
          WORKDIR,
          image,
          "sleep",
          String(spec.timeouts.prepareSec + 60),
        ],
        { timeoutMs: 60_000 },
      );
      if (create.exitCode !== 0) throw new Error(`docker create failed: ${create.stderr}`);

      // The checkout is copied in rather than bind-mounted: the host source must not be
      // mutable from inside the container.
      const copy = await docker(["cp", `${req.sourcePath}/.`, `${containerId}:${WORKDIR}`], {
        timeoutMs: spec.timeouts.prepareSec * 1000,
      });
      if (copy.exitCode !== 0) throw new Error(`docker cp failed: ${copy.stderr}`);

      const start = await docker(["start", containerId], { timeoutMs: 30_000 });
      if (start.exitCode !== 0) throw new Error(`docker start failed: ${start.stderr}`);

      await docker(["exec", containerId, "mkdir", "-p", CACHE_DIR, COREPACK_HOME], {
        timeoutMs: 20_000,
      });

      // The checkout is copied in from the host, so its files are owned by the host uid
      // and git refuses to touch it ("dubious ownership"). Without this every git tool
      // fails and the agent silently loses the diff.
      await docker(
        ["exec", containerId, "git", "config", "--global", "--add", "safe.directory", WORKDIR],
        { timeoutMs: 20_000 },
      );

      const gitCheck = await docker(["exec", containerId, "git", "--version"], {
        timeoutMs: 20_000,
      });
      if (gitCheck.exitCode !== 0) {
        log.warn(
          { image },
          "git is unavailable in this image; git_diff/git_log/git_blame will not work",
        );
      }

      const setupResults: ExecResult[] = [];
      for (const command of setup) {
        log.info({ command }, "setup");
        const res = await docker(
          ["exec", "--workdir", WORKDIR, containerId, "sh", "-lc", command],
          { timeoutMs: spec.timeouts.prepareSec * 1000, signal: req.signal },
        );
        setupResults.push({ ...res, command });
        if (res.exitCode !== 0) {
          log.warn(
            { command, exitCode: res.exitCode, stderr: res.stderr.slice(0, 800) },
            "setup step failed",
          );
        }
      }

      // Snapshot so every agent gets an identical starting point without repeating install.
      const commit = await docker(
        [
          "commit",
          "--change",
          `LABEL ${LABEL_MANAGED}=true`,
          "--change",
          `LABEL ${LABEL_REVIEW}=${reviewId}`,
          "--change",
          `LABEL ${LABEL_CREATED}=${new Date().toISOString()}`,
          containerId,
          `maestro/snapshot:${id}`,
        ],
        { timeoutMs: spec.timeouts.prepareSec * 1000 },
      );
      if (commit.exitCode !== 0) throw new Error(`docker commit failed: ${commit.stderr}`);

      // A fork PR may READ the cache but never write it: one hostile fork would
      // otherwise poison the dependency layer for every later review of this repo.
      const installOk = setupResults.every((r) => r.exitCode === 0);
      if (cachedTag && installOk && mayWriteCache(spec.trust)) {
        await docker(["tag", `maestro/snapshot:${id}`, cachedTag], { timeoutMs: 30_000 });
        log.info({ cachedTag }, "dependency snapshot cached");
      }

      // Closed here rather than only in `finally`: the containerised proxy's log lives
      // inside its container, so it has to be stopped and read before the value that
      // reports it is built. `close()` is idempotent, and `finally` still runs it on
      // every path that does not reach here.
      await proxy.close();

      return {
        id,
        reviewId,
        imageId: `maestro/snapshot:${id}`,
        toolchain,
        allowedCommands,
        setupResults,
        egressLog: proxy.log(),
        egressEnforcement: proxy.enforcement,
        cacheHit: false,
      };
    } finally {
      // The proxy closes with the phase: no network survives into analyze.
      await proxy.close();
      await docker(["rm", "-f", containerId], { timeoutMs: 60_000 });
    }
  }

  async analyze(
    env: PreparedEnvironment,
    opts: { agentId?: string; spec: EnvSpec },
  ): Promise<Sandbox> {
    const { spec } = opts;
    const id = newId("env");
    const containerId = `maestro-run-${id}`;

    const args = [
      "run",
      "-d",
      "--name",
      containerId,
      "--label",
      `${LABEL_MANAGED}=true`,
      "--label",
      `${LABEL_REVIEW}=${env.reviewId}`,
      "--label",
      `${LABEL_CREATED}=${new Date().toISOString()}`,
      // The analyze posture: no network, no privileges, no writable system, no secrets.
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      String(spec.pids),
      "--memory",
      parseMemory(spec.memory),
      "--cpus",
      String(spec.cpus),
      "--tmpfs",
      `/tmp:rw,size=${spec.tmpfs.replace(/i?[bB]$/, "")},exec`,
      "--env",
      `TMPDIR=${CACHE_DIR}`,
      "--env",
      `npm_config_cache=${CACHE_DIR}/npm`,
      "--env",
      `XDG_CACHE_HOME=${CACHE_DIR}`,
      "--env",
      `COREPACK_HOME=${COREPACK_HOME}`,
      "--workdir",
      WORKDIR,
    ];
    // Tests commonly write into the checkout (coverage, .next, caches). A writable
    // overlay is opt-in per playbook so the default stays locked down.
    if (spec.writableWorkdir) args.push("--tmpfs", `${WORKDIR}/.maestro-scratch:rw,exec`);

    args.push(env.imageId, "sleep", String(spec.timeouts.analyzeSec + 60));

    const run = await docker(args, { timeoutMs: 60_000 });
    if (run.exitCode !== 0) throw new Error(`docker run failed: ${run.stderr}`);
    await docker(["exec", containerId, "mkdir", "-p", CACHE_DIR], { timeoutMs: 20_000 });
    // Belt and braces: the snapshot carries the global config, but a custom base image
    // may not, and a silent git failure costs the agent its diff.
    await docker(
      ["exec", containerId, "git", "config", "--global", "--add", "safe.directory", WORKDIR],
      { timeoutMs: 20_000 },
    );

    return {
      id,
      agentId: opts.agentId,
      containerId,
      exec: async (command, execOpts) => ({
        ...(await docker(["exec", "--workdir", WORKDIR, containerId, "sh", "-lc", command], {
          timeoutMs: (execOpts?.timeoutSec ?? spec.timeouts.commandSec) * 1000,
        })),
        command,
      }),
      readFile: async (path, maxBytes = 256 * 1024) => {
        const res = await docker(
          ["exec", "--workdir", WORKDIR, containerId, "head", "-c", String(maxBytes), path],
          { timeoutMs: 30_000, maxOutputBytes: maxBytes + 1024 },
        );
        if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `cannot read ${path}`);
        return res.stdout;
      },
      destroy: async () => {
        await docker(["rm", "-f", containerId], { timeoutMs: 60_000 });
      },
    };
  }

  /**
   * Removes cached dependency layers. Separate from reap() on purpose: dropping the
   * cache makes the next review of every repository slow again, so it is opt-in.
   */
  async reapDependencyCache(): Promise<number> {
    const ids = await listIds(["images", "-q", "maestro/deps"]);
    for (const id of ids) await docker(["rmi", "-f", id], { timeoutMs: 60_000 });
    return ids.length;
  }

  async reap(
    opts: {
      reviewId?: string;
      olderThanMs?: number;
      /**
       * Review ids whose containers must be left alone.
       *
       * An unscoped sweep matched every Maestro-labelled container, which includes the
       * ones a running daemon is using right now — so `maestro reap` during a review
       * destroyed it. Worse, `doctor` counted those same live containers as "leaked" and
       * told the operator to run exactly that command.
       */
      protectReviewIds?: Iterable<string>;
    } = {},
  ): Promise<{
    containers: number;
    images: number;
    networks: number;
    protected: number;
  }> {
    const filters = [`label=${LABEL_MANAGED}=true`];
    if (opts.reviewId) filters.push(`label=${LABEL_REVIEW}=${opts.reviewId}`);
    const filterArgs = filters.flatMap((f) => ["--filter", f]);

    const protectedIds = new Set(opts.protectReviewIds ?? []);
    const cutoff = opts.olderThanMs ? Date.now() - opts.olderThanMs : undefined;
    const allContainers = await listIds(["ps", "-aq", ...filterArgs]);
    const containers: string[] = [];
    let skipped = 0;
    for (const c of allContainers) {
      const { reviewId, createdAt } = await containerLabels(c);
      if (reviewId && protectedIds.has(reviewId)) {
        skipped++;
        continue;
      }
      // `olderThanMs` was accepted and ignored, so the daemon's periodic sweep — which
      // passes a two-hour age — deleted containers of every age, including the ones its
      // own reviews were using at that moment.
      //
      // Fails CLOSED on an unknown age. The first version skipped the check when the
      // created label was missing or unparseable, which force-removed exactly those
      // containers at any age — reaching the failure this guard exists to prevent
      // through the unlabelled path. A container you cannot date is not provably
      // garbage. An unscoped `maestro reap`, which passes no age, still collects them.
      if (cutoff !== undefined && (createdAt === undefined || createdAt > cutoff)) {
        skipped++;
        continue;
      }
      containers.push(c);
    }
    for (const c of containers) await docker(["rm", "-f", c], { timeoutMs: 60_000 });

    // Snapshot images are where disk actually fills up; a reaper that only sweeps
    // containers leaves the layers behind.
    //
    // The dependency cache is tagged onto the SAME image id as the review's snapshot,
    // so deleting by id would destroy the cache on every teardown - which silently made
    // the whole caching feature useless. Skip any image that is also a cache entry;
    // `reapDependencyCache()` is the deliberate way to remove those.
    const cacheIds = new Set(await listIds(["images", "-q", "maestro/deps"]));
    const images: string[] = [];
    for (const id of await listIds(["images", "-q", ...filterArgs])) {
      if (cacheIds.has(id)) continue;

      // The same two guards as the containers above. Applying them to only half the
      // sweep left a review's snapshot deletable while its agents were still starting
      // from it: the engine creates one container per agent as scheduler slots free up,
      // so there is a real window between prepare finishing and the last agent starting.
      // Every later `docker run` against a deleted image fails.
      const { reviewId, createdAt } = await imageLabels(id);
      if (reviewId && protectedIds.has(reviewId)) {
        skipped++;
        continue;
      }
      if (cutoff !== undefined && (createdAt === undefined || createdAt > cutoff)) {
        skipped++;
        continue;
      }
      images.push(id);
    }
    for (const i of images) await docker(["rmi", "-f", i], { timeoutMs: 60_000 });

    // Networks are the leak class enforcement introduced, and the one nothing else here
    // knew about: a review that dies between creating its --internal network and tearing
    // it down leaves it behind, and `docker network ls` fills up with them. They go last
    // because a network with anything still attached cannot be removed — the containers
    // above had to be gone first.
    //
    // Same two guards as everything else: a live review's network is not garbage, and
    // neither is one too young to date.
    const networks: string[] = [];
    for (const n of await listManagedNetworks()) {
      if (n.reviewId && protectedIds.has(n.reviewId)) {
        skipped++;
        continue;
      }
      if (opts.reviewId && n.reviewId !== opts.reviewId) continue;
      if (cutoff !== undefined && (n.createdAt === undefined || n.createdAt > cutoff)) {
        skipped++;
        continue;
      }
      networks.push(n.name);
    }
    for (const n of networks) await docker(["network", "rm", n], { timeoutMs: 30_000 });

    return {
      containers: containers.length,
      images: images.length,
      networks: networks.length,
      protected: skipped,
    };
  }
}

/** A review network, with the same labels every other managed resource carries. */
export interface ManagedNetwork {
  name: string;
  reviewId?: string;
  createdAt?: number;
}

/**
 * The review networks Maestro created.
 *
 * Exported for the same reason `listManagedContainers` is: `doctor` reports strays and
 * the reaper removes them, and if those two ever disagree about what a stray is, doctor
 * recommends a command that destroys what it has just called safe.
 */
export async function listManagedNetworks(): Promise<ManagedNetwork[]> {
  const res = await docker(
    ["network", "ls", "--filter", `label=${LABEL_MANAGED}=true`, "--format", "{{.Name}}"],
    { timeoutMs: 20_000 },
  );
  const names = res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const out: ManagedNetwork[] = [];
  for (const name of names) {
    const labels = await docker(
      [
        "network",
        "inspect",
        "--format",
        `{{index .Labels "${LABEL_REVIEW}"}}|{{index .Labels "${LABEL_CREATED}"}}`,
        name,
      ],
      { timeoutMs: 20_000 },
    );
    out.push({ name, ...parseLabelPair(labels.stdout) });
  }
  return out;
}

/** The same labels, read from an image rather than a container. */
async function imageLabels(imageId: string): Promise<{ reviewId?: string; createdAt?: number }> {
  const res = await docker(
    [
      "image",
      "inspect",
      "--format",
      `{{index .Config.Labels "${LABEL_REVIEW}"}}|{{index .Config.Labels "${LABEL_CREATED}"}}`,
      imageId,
    ],
    { timeoutMs: 20_000 },
  );
  return parseLabelPair(res.stdout);
}

/**
 * Every managed container, with the review it belongs to and whether it is running.
 *
 * Exported because `doctor` was answering the same question with its own two `docker ps`
 * calls and a different definition of "stray": it called a stopped container a stray and
 * a running one "in flight". A container left running by a killed daemon belongs to no
 * live review, and doctor reported it as healthy activity — the one tool somebody runs to
 * find leaks, blind to the commonest way they happen.
 *
 * Whether a container is a stray is a question about its REVIEW, not about its process
 * state, and the answer lives in the store. This returns what is needed to ask it, so the
 * reaper and the doctor cannot drift into different answers.
 */
export interface ManagedContainer {
  id: string;
  reviewId?: string;
  createdAt?: number;
  running: boolean;
}

export async function listManagedContainers(): Promise<ManagedContainer[]> {
  const filterArgs = ["--filter", `label=${LABEL_MANAGED}=true`];
  const all = await listIds(["ps", "-aq", ...filterArgs]);
  const running = new Set(await listIds(["ps", "-q", ...filterArgs]));
  const out: ManagedContainer[] = [];
  for (const id of all) {
    out.push({ id, ...(await containerLabels(id)), running: running.has(id) });
  }
  return out;
}

/**
 * Splits managed containers into the ones a live review owns and the ones nothing does.
 *
 * One function rather than a rule spelled out at each call site: `doctor` recommends
 * `maestro reap`, and the reaper decides what to destroy. If those two ever disagree
 * about what a stray is, `doctor` starts recommending a command that destroys what it
 * has just called safe — which is a failure this project has already had, in both
 * directions.
 */
export function classifyContainers(
  managed: ManagedContainer[],
  liveReviewIds: Iterable<string>,
): { inFlight: ManagedContainer[]; strays: ManagedContainer[] } {
  const live = new Set(liveReviewIds);
  const owned = (c: ManagedContainer) => Boolean(c.reviewId && live.has(c.reviewId));
  return { inFlight: managed.filter(owned), strays: managed.filter((c) => !owned(c)) };
}

/** The review a container belongs to and when it was created, from its own labels. */
async function containerLabels(
  containerId: string,
): Promise<{ reviewId?: string; createdAt?: number }> {
  const res = await docker(
    [
      "inspect",
      "--format",
      `{{index .Config.Labels "${LABEL_REVIEW}"}}|{{index .Config.Labels "${LABEL_CREATED}"}}`,
      containerId,
    ],
    { timeoutMs: 20_000 },
  );
  return parseLabelPair(res.stdout);
}

/** Shared by the container and image readers, so the two cannot interpret labels differently. */
function parseLabelPair(stdout: string): { reviewId?: string; createdAt?: number } {
  const [review, created] = stdout.trim().split("|");
  const usable = (v?: string) => (v && v !== "<no value>" ? v : undefined);
  const createdAt = usable(created) ? Date.parse(usable(created) as string) : Number.NaN;
  return {
    reviewId: usable(review),
    createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
  };
}

/**
 * Layers the current checkout onto a cached dependency image.
 *
 * Only the dependency layer is reused; the source always comes from this pull request,
 * or a review would silently analyse the previous one's code.
 */
async function refreshCheckout(
  cachedTag: string,
  req: PrepareRequest,
  spec: EnvSpec,
  id: string,
  reviewId: string,
): Promise<string | null> {
  const containerId = `maestro-cache-${id}`;
  try {
    const create = await docker(
      [
        "create",
        "--name",
        containerId,
        "--label",
        `${LABEL_MANAGED}=true`,
        "--label",
        `${LABEL_REVIEW}=${reviewId}`,
        "--label",
        `${LABEL_CREATED}=${new Date().toISOString()}`,
        "--workdir",
        WORKDIR,
        cachedTag,
        "sleep",
        "60",
      ],
      { timeoutMs: 60_000 },
    );
    if (create.exitCode !== 0) return null;

    const copy = await docker(["cp", `${req.sourcePath}/.`, `${containerId}:${WORKDIR}`], {
      timeoutMs: spec.timeouts.prepareSec * 1000,
    });
    if (copy.exitCode !== 0) return null;

    const commit = await docker(
      [
        "commit",
        "--change",
        `LABEL ${LABEL_MANAGED}=true`,
        "--change",
        `LABEL ${LABEL_REVIEW}=${reviewId}`,
        // The created label matters as much here as on the cold path. The age guard
        // fails closed on an image it cannot date, so a cache-hit snapshot without this
        // was skipped by every periodic sweep for ever — on the hottest path there is,
        // since every review of a repo after the first hits the cache, and a dependency
        // layer can be gigabytes.
        "--change",
        `LABEL ${LABEL_CREATED}=${new Date().toISOString()}`,
        containerId,
        `maestro/snapshot:${id}`,
      ],
      { timeoutMs: 300_000 },
    );
    return commit.exitCode === 0 ? `maestro/snapshot:${id}` : null;
  } finally {
    await docker(["rm", "-f", containerId], { timeoutMs: 60_000 });
  }
}

/**
 * Ids from a `docker ... -q` listing, each one once.
 *
 * `docker images -q` prints a line per TAG, not per image, and Maestro tags every
 * snapshot twice — once as the review's snapshot and once as the dependency cache. So a
 * listing of three images came back as six lines, and the reaper inspected each image
 * twice, called `docker rmi` on each id twice, and reported double the number of images
 * it had actually removed. The second `rmi` fails silently on an id that is already gone,
 * so nothing broke; the count an operator reads was simply wrong, and so was `protected`.
 *
 * Verified against the running daemon: six lines, three unique ids.
 */
export function uniqueIds(stdout: string): string[] {
  return [
    ...new Set(
      stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

async function listIds(args: string[]): Promise<string[]> {
  const res = await docker(args, { timeoutMs: 30_000 });
  return res.exitCode === 0 ? uniqueIds(res.stdout) : [];
}

async function snapshotOfDirectory(path: string) {
  const { readdirSync, readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const files = existsSync(path) ? readdirSync(path) : [];
  return {
    files,
    read: (rel: string): string | undefined => {
      try {
        return readFileSync(join(path, rel), "utf8");
      } catch {
        return undefined;
      }
    },
  };
}

export { docker as dockerCommand };

/**
 * This container's own name on the Docker network, for siblings to dial.
 *
 * The hostname of a container is its short id, which Docker's embedded DNS resolves on
 * any user-defined network. Reading it is more reliable than asking the caller to keep a
 * service name in sync with the compose file.
 */
async function ownContainerName(): Promise<string | undefined> {
  if (!runningInContainer()) return undefined;
  try {
    const { hostname } = await import("node:os");
    return hostname();
  } catch {
    return undefined;
  }
}

// ── The prepare-phase proxy, in either posture ───────────────────────────────

/** Where the sandbox is pointed, and what it costs to tear down. */
interface PreparePhaseProxy {
  /** What HTTP_PROXY is set to inside the prepare container. */
  url: string;
  /** Networking arguments the prepare container must be created with. */
  containerArgs: string[];
  enforcement: EgressEnforcement;
  /** Aggregated egress log. Only complete after `close()`. */
  log(): { host: string; allowed: boolean; count: number }[];
  /** Idempotent: prepare closes explicitly to harvest the log, and again in `finally`. */
  close(): Promise<void>;
}

const PROXY_PORT = 8080;

/** A stock glibc image; the proxy binary is copied in, so nothing is built or published. */
function proxyBaseImage(): string {
  return process.env.MAESTRO_PROXY_BASE_IMAGE?.trim() || "debian:bookworm-slim";
}

/**
 * Starts the proxy in whichever posture the spec asks for.
 *
 * Fails CLOSED. If enforcement is configured and the proxy cannot be started — no Linux
 * binary, no base image, Docker refusing the network — this throws and the prepare phase
 * fails with the reason. It must never quietly fall back to advisory: a supply-chain
 * control that stops enforcing without saying so is worse than one that was never
 * claimed, because everything downstream still reports that the allowlist applied.
 */
async function startPreparePhaseProxy(opts: {
  spec: EnvSpec;
  reviewId: string;
  id: string;
  log: Logger;
}): Promise<PreparePhaseProxy> {
  if (opts.spec.egressEnforcement === "advisory") return startAdvisoryProxy(opts);
  return startEnforcedProxy(opts);
}

/**
 * The older posture: the proxy runs in this process and is offered through HTTP_PROXY.
 *
 * Kept because a host that cannot supply a Linux binary for the proxy container should
 * still get the allowlist as a default, and because it is what Compose deployments with
 * a shared sandbox network already use. What it cannot do is stop a tool that ignores
 * the proxy variables, which is why it is no longer the default.
 */
async function startAdvisoryProxy(opts: {
  spec: EnvSpec;
  log: Logger;
}): Promise<PreparePhaseProxy> {
  const proxy = await startEgressProxy(opts.spec.egressAllowlist);

  // Sandboxes must dial an address they can actually reach, and how depends on whether
  // Maestro is a process on the host or a container beside them.
  //
  // On a host, host.docker.internal works. In a container it does not: it resolves to
  // the host, not to us. The first attempt at fixing that published the proxy on the
  // docker bridge gateway, which is wrong twice over — it is a real interface only on
  // Linux, so `docker run -p 172.17.0.1:...` fails outright on Docker Desktop with
  // "can't assign requested address" and the container never starts; and it routes
  // container-to-container traffic out to the host and back for no reason.
  //
  // Joining the sandbox to Maestro's own network removes the problem rather than working
  // around it: Docker's embedded DNS resolves the service name, the traffic never leaves
  // the daemon, nothing is published to any host interface, and it behaves identically
  // on every platform.
  const sandboxNetwork = process.env.MAESTRO_SANDBOX_NETWORK?.trim();
  const proxyHost =
    process.env.MAESTRO_PROXY_HOST?.trim() ||
    (sandboxNetwork ? await ownContainerName() : undefined) ||
    "host.docker.internal";

  if (!sandboxNetwork && !process.env.MAESTRO_PROXY_HOST && runningInContainer()) {
    opts.log.warn(
      "Maestro is running inside a container but neither MAESTRO_SANDBOX_NETWORK nor " +
        "MAESTRO_PROXY_HOST is set; sandboxes will dial host.docker.internal, which " +
        "does not resolve to this container, so every dependency install will fail. " +
        "Set MAESTRO_SANDBOX_NETWORK to the network this container is on.",
    );
  }

  const containerArgs = [
    ...(sandboxNetwork ? ["--network", sandboxNetwork] : []),
    ...(!sandboxNetwork && process.platform === "linux"
      ? ["--add-host", "host.docker.internal:host-gateway"]
      : []),
  ];

  let closed = false;
  return {
    url: `http://${proxyHost}:${proxy.port}`,
    containerArgs,
    enforcement: "advisory",
    log: () => proxy.log.map((e) => ({ host: e.host, allowed: e.allowed, count: e.count })),
    close: async () => {
      if (closed) return;
      closed = true;
      await proxy.close();
    },
  };
}

/**
 * The enforced posture: an --internal network whose only route out is a proxy container.
 *
 * The topology is what makes the allowlist a control. A container on an `--internal`
 * network has no default route and no external DNS — measured, not assumed: a direct
 * socket to 1.1.1.1 and an external lookup both fail from inside. The proxy container
 * sits on that network AND on the normal bridge, so it is the only path, and the
 * allowlist decides what crosses it.
 *
 * Attach order matters. The proxy is created on `bridge` so that is its default route —
 * an `--internal` network has no gateway, and creating it there first would leave the
 * proxy itself unable to reach anything.
 */
async function startEnforcedProxy(opts: {
  spec: EnvSpec;
  reviewId: string;
  id: string;
  log: Logger;
}): Promise<PreparePhaseProxy> {
  const { spec, reviewId, id, log } = opts;
  const networkName = `maestro-net-${id}`;
  const proxyName = `maestro-proxy-${id}`;
  const created = new Date().toISOString();
  const labels = [
    "--label",
    `${LABEL_MANAGED}=true`,
    "--label",
    `${LABEL_REVIEW}=${reviewId}`,
    "--label",
    `${LABEL_CREATED}=${created}`,
  ];

  const binary = await resolveProxyBinary({ version: MAESTRO_VERSION });
  log.info({ source: binary.source, path: binary.path }, "egress proxy binary");

  const image = proxyBaseImage();
  const pull = await docker(["pull", image], { timeoutMs: 300_000 });
  if (pull.exitCode !== 0 && !pull.stderr.includes("up to date")) {
    log.warn({ image, stderr: pull.stderr.slice(0, 300) }, "proxy image pull failed; trying local");
  }

  let harvested: { host: string; allowed: boolean; count: number }[] = [];
  let closed = false;

  const teardown = async () => {
    await docker(["rm", "-f", proxyName], { timeoutMs: 60_000 });
    // The network cannot be removed while anything is attached, so it goes last.
    await docker(["network", "rm", networkName], { timeoutMs: 30_000 });
  };

  const net = await docker(["network", "create", "--internal", ...labels, networkName], {
    timeoutMs: 30_000,
  });
  if (net.exitCode !== 0) {
    throw new Error(
      `Could not create the review's isolated network: ${net.stderr.trim()}\n` +
        "The prepare-phase egress allowlist cannot be enforced without it. Set " +
        "egressEnforcement: advisory in the playbook's envSpec to accept the weaker posture.",
    );
  }

  try {
    const create = await docker(
      [
        "create",
        "--name",
        proxyName,
        ...labels,
        // bridge FIRST, so it is the default route: --internal networks have no gateway.
        "--network",
        "bridge",
        // The one container with network during prepare, so it gets the same posture as
        // the sandbox: no capabilities, no privilege escalation, nothing writable but
        // the tmpfs its own log lives on, and an unprivileged uid — binding 8080 needs
        // no root.
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "128",
        "--memory",
        "256m",
        "--user",
        "65534:65534",
        // No --read-only, and the integration suite is why: `docker cp` into a container
        // with a read-only rootfs fails with "container rootfs is marked read-only", and
        // copying the binary in is how it gets there. Bind-mounting it instead would fix
        // that and break the Compose deployment — the host daemon cannot see a path
        // inside Maestro's own container, and `docker cp` is the only one of the two that
        // works against a daemon that does not share this filesystem.
        //
        // No --tmpfs on /tmp either, for a reason the integration test found: a tmpfs is
        // freed when the container stops, and the egress log is read AFTER the stop —
        // `docker cp` from a stopped container is what makes the log survive a hard kill.
        // Mounting one there deleted the log at the exact moment it was needed, and the
        // review reported nothing blocked when four attempts had been. The log is
        // aggregated per host, so it is a few hundred bytes on a writable rootfs.
        //
        // Everything else in this posture stands: no capabilities, no privilege
        // escalation, an unprivileged uid (binding 8080 needs no root), a pid ceiling and
        // a memory cap.
        "--entrypoint",
        "/usr/local/bin/maestro",
        image,
        "egress-proxy",
        "--port",
        String(PROXY_PORT),
        "--allowlist",
        spec.egressAllowlist.join(","),
      ],
      { timeoutMs: 60_000 },
    );
    if (create.exitCode !== 0) {
      throw new Error(`Could not create the egress proxy container: ${create.stderr.trim()}`);
    }

    const cp = await docker(["cp", binary.path, `${proxyName}:/usr/local/bin/maestro`], {
      timeoutMs: 120_000,
    });
    if (cp.exitCode !== 0) {
      throw new Error(`Could not copy the proxy binary into the container: ${cp.stderr.trim()}`);
    }

    const connect = await docker(["network", "connect", networkName, proxyName], {
      timeoutMs: 30_000,
    });
    if (connect.exitCode !== 0) {
      throw new Error(`Could not attach the proxy to the review network: ${connect.stderr.trim()}`);
    }

    const start = await docker(["start", proxyName], { timeoutMs: 60_000 });
    if (start.exitCode !== 0) {
      throw new Error(`The egress proxy container did not start: ${start.stderr.trim()}`);
    }

    await waitForProxyReady(proxyName, log);

    return {
      url: `http://${proxyName}:${PROXY_PORT}`,
      // Only the internal network. No host gateway, no bridge: the proxy is the route.
      containerArgs: ["--network", networkName],
      enforcement: "enforced",
      log: () => harvested,
      close: async () => {
        if (closed) return;
        closed = true;
        // SIGTERM, so the proxy writes its final snapshot before the container exits.
        await docker(["stop", "-t", "5", proxyName], { timeoutMs: 60_000 });
        harvested = await harvestEgressLog(proxyName, log);
        await teardown();
      },
    };
  } catch (err) {
    await teardown();
    throw err;
  }
}

/**
 * Waits for the proxy to accept connections.
 *
 * Not optional: a package manager that starts first gets ECONNREFUSED, and most do not
 * retry it — so the review fails with a network error that looks nothing like an
 * allowlist and points at the wrong thing entirely.
 */
async function waitForProxyReady(proxyName: string, log: Logger): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const probe = await docker(["exec", proxyName, "test", "-f", PROXY_READY_PATH], {
      timeoutMs: 10_000,
    });
    if (probe.exitCode === 0) return;

    // If the container has already exited there is nothing to wait for, and its logs are
    // the only thing that explains why.
    const alive = await docker(["inspect", "-f", "{{.State.Running}}", proxyName], {
      timeoutMs: 10_000,
    });
    if (alive.stdout.trim() !== "true") {
      const why = await docker(["logs", "--tail", "20", proxyName], { timeoutMs: 10_000 });
      throw new Error(
        `The egress proxy exited before it was ready:\n${why.stdout.trim()}\n${why.stderr.trim()}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  log.error({ proxyName }, "egress proxy never became ready");
  throw new Error(
    "The egress proxy did not start listening within 60s, so the prepare phase has no " +
      "allowed route to the network. Nothing was run.",
  );
}

/** Copies the aggregated log out of the (stopped) proxy container. */
async function harvestEgressLog(
  proxyName: string,
  log: Logger,
): Promise<{ host: string; allowed: boolean; count: number }[]> {
  const dir = mkdtempSync(join(tmpdir(), "maestro-egress-"));
  const dest = join(dir, "egress.json");
  try {
    const cp = await docker(["cp", `${proxyName}:${PROXY_LOG_PATH}`, dest], { timeoutMs: 30_000 });
    if (cp.exitCode !== 0) {
      log.warn({ stderr: cp.stderr.slice(0, 300) }, "could not read the proxy's egress log");
      return [];
    }
    const parsed = JSON.parse(readFileSync(dest, "utf8")) as {
      host: string;
      allowed: boolean;
      count: number;
    }[];
    return parsed.map((e) => ({ host: e.host, allowed: e.allowed, count: e.count }));
  } catch (err) {
    // A missing log must not fail an otherwise successful review: the review comment
    // loses a line, which is not worth throwing away the findings for.
    log.warn({ err }, "could not read the proxy's egress log");
    return [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
