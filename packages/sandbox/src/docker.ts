import { spawn } from "node:child_process";
import { logger, newId } from "@maestro/core";
import type { EnvSpec } from "@maestro/playbook";
import { dependencyCacheKey, mayWriteCache, snapshotTag } from "./cache.js";
import { runningInContainer, startEgressProxy } from "./egress-proxy.js";
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

  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let outBytes = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const onAbort = () => {
      timedOut = true;
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
        exitCode: timedOut ? 124 : (code ?? 1),
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
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
    const proxy = await startEgressProxy(spec.egressAllowlist);
    const containerId = `maestro-prep-${id}`;

    try {
      // Sandboxes must dial an address they can actually reach, and how depends on
      // whether Maestro is a process on the host or a container beside them.
      //
      // On a host, host.docker.internal works. In a container it does not: it resolves to
      // the host, not to us. The first attempt at fixing that published the proxy on the
      // docker bridge gateway, which is wrong twice over — it is a real interface only on
      // Linux, so `docker run -p 172.17.0.1:...` fails outright on Docker Desktop with
      // "can't assign requested address" and the container never starts; and it routes
      // container-to-container traffic out to the host and back for no reason.
      //
      // Joining the sandbox to Maestro's own network removes the problem rather than
      // working around it: Docker's embedded DNS resolves the service name, the traffic
      // never leaves the daemon, nothing is published to any host interface, and it
      // behaves identically on every platform. Only the PREPARE phase joins — analyze
      // still runs with `--network none`, so the isolation posture is untouched.
      const sandboxNetwork = process.env.MAESTRO_SANDBOX_NETWORK?.trim();
      const proxyHost =
        process.env.MAESTRO_PROXY_HOST?.trim() ||
        (sandboxNetwork ? await ownContainerName() : undefined) ||
        "host.docker.internal";

      if (!sandboxNetwork && !process.env.MAESTRO_PROXY_HOST && runningInContainer()) {
        log.warn(
          "Maestro is running inside a container but neither MAESTRO_SANDBOX_NETWORK nor " +
            "MAESTRO_PROXY_HOST is set; sandboxes will dial host.docker.internal, which " +
            "does not resolve to this container, so every dependency install will fail. " +
            "Set MAESTRO_SANDBOX_NETWORK to the network this container is on.",
        );
      }

      const networkArgs = sandboxNetwork ? ["--network", sandboxNetwork] : [];
      const hostGateway =
        !sandboxNetwork && process.platform === "linux"
          ? ["--add-host", "host.docker.internal:host-gateway"]
          : [];
      const proxyUrl = `http://${proxyHost}:${proxy.port}`;

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
          ...networkArgs,
          ...hostGateway,
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

      return {
        id,
        reviewId,
        imageId: `maestro/snapshot:${id}`,
        toolchain,
        allowedCommands,
        setupResults,
        egressLog: proxy.log.map((e) => ({ host: e.host, allowed: e.allowed })),
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
      if (cutoff !== undefined && createdAt !== undefined && createdAt > cutoff) {
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
    const images = (await listIds(["images", "-q", ...filterArgs])).filter(
      (id) => !cacheIds.has(id),
    );
    for (const i of images) await docker(["rmi", "-f", i], { timeoutMs: 60_000 });

    return { containers: containers.length, images: images.length, protected: skipped };
  }
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
  const [review, created] = res.stdout.trim().split("|");
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

async function listIds(args: string[]): Promise<string[]> {
  const res = await docker(args, { timeoutMs: 30_000 });
  return res.exitCode === 0
    ? res.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
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
