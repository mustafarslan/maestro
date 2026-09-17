import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { logger, maestroHome } from "@maestro/core";

const exec = promisify(execFile);

/**
 * Finding a Linux build of this binary, to run the proxy inside a container.
 *
 * Enforcing the allowlist means the proxy cannot live in the daemon: an `--internal`
 * network has no gateway, so a sandbox on one cannot reach the host at all. The proxy has
 * to be a container, and the tidiest thing to put in that container is this same binary —
 * one implementation of the allowlist rather than two, and no third-party proxy to
 * scrape logs out of.
 *
 * The whole difficulty is that "this same binary" may be the wrong architecture or the
 * wrong operating system. A macOS binary mounted into a Debian container gives
 * `exec format error`, which is obvious in hindsight and would otherwise be discovered
 * at the first review rather than here.
 *
 * Note that the architecture that matters is DOCKER'S. Docker Desktop can run a
 * different one from the host, and the failure mode is again `exec format error`.
 */

/** Docker's own architecture, in the spelling the release assets use. */
export async function dockerArch(): Promise<"x64" | "arm64"> {
  const { stdout } = await exec("docker", ["version", "--format", "{{.Server.Arch}}"]);
  const arch = stdout.trim();
  if (arch === "arm64" || arch === "aarch64") return "arm64";
  if (arch === "amd64" || arch === "x86_64") return "x64";
  throw new Error(
    `Docker reports an architecture Maestro has no binary for: "${arch}". ` +
      "Set MAESTRO_PROXY_BINARY to a Linux build of maestro for that architecture, or set " +
      "egressEnforcement: advisory in the playbook's envSpec.",
  );
}

/** True when this process IS the compiled binary rather than node running its bundle. */
function ownBinaryPath(): string | undefined {
  const exe = process.execPath;
  // Under `node dist/index.js` execPath is node, which is not what we want to copy.
  return basename(exe).startsWith("maestro") ? exe : undefined;
}

export interface ProxyBinary {
  path: string;
  /** How it was found; recorded so a confusing review has something to read. */
  source: "env" | "local-build" | "own-binary" | "cache" | "download";
}

/**
 * Resolves a Linux binary for Docker's architecture, or explains every way to supply one.
 *
 * Deliberately ordered so an explicit answer always wins over a clever one.
 */
export async function resolveProxyBinary(opts: {
  version: string;
  /**
   * Docker's architecture. Defaults to asking Docker, which is what production wants.
   *
   * Passed explicitly by tests: without it a unit test needs Docker installed and its
   * result depends on the machine, which is how this file passed on an arm64 laptop and
   * failed on an x64 runner — picking a different release asset and reporting it as a
   * wrong URL.
   */
  arch?: "x64" | "arm64";
}): Promise<ProxyBinary> {
  const arch = opts.arch ?? (await dockerArch());

  // 1. Told explicitly. Always first: an operator who sets this has a reason, and a
  //    fallback that quietly used something else would be the harder bug.
  const explicit = process.env.MAESTRO_PROXY_BINARY?.trim();
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`MAESTRO_PROXY_BINARY points at ${explicit}, which does not exist.`);
    }
    return { path: resolve(explicit), source: "env" };
  }

  // 2. A deliberate local cross-compile (`pnpm run build:proxy-binary`). Present only in
  //    a checkout, and if somebody built it they meant to use it.
  const localBuild = resolve(`dist/maestro-linux-${arch}`);
  if (existsSync(localBuild)) return { path: localBuild, source: "local-build" };

  // 3. This process, when it is already a Linux binary of the right architecture — the
  //    Linux-host and Compose cases, which are the ones that need no download at all.
  const own = ownBinaryPath();
  if (own && process.platform === "linux" && hostArchMatches(arch)) {
    return { path: own, source: "own-binary" };
  }

  // 4. Downloaded once and cached, keyed by version: a cached binary from an older
  //    version may predate the `egress-proxy` subcommand entirely.
  const cacheDir = join(maestroHome(), "cache");
  const cached = join(cacheDir, `maestro-linux-${arch}-${opts.version}`);
  if (existsSync(cached) && statSync(cached).size > 0) {
    return { path: cached, source: "cache" };
  }

  // 5. Fetch the release asset.
  const downloaded = await downloadReleaseBinary({ arch, version: opts.version, cacheDir, cached });
  if (downloaded) return { path: downloaded, source: "download" };

  throw new Error(
    `Maestro needs a linux-${arch} build of itself to enforce the prepare-phase egress ` +
      "allowlist, and could not find or fetch one. Three ways forward:\n" +
      "  • pnpm run build:proxy-binary   (in a checkout; cross-compiles it here)\n" +
      "  • MAESTRO_PROXY_BINARY=/path/to/maestro-linux-" +
      arch +
      "\n" +
      "  • set egressEnforcement: advisory in the playbook's envSpec, which accepts that a\n" +
      "    tool ignoring HTTP_PROXY can reach the internet during prepare\n" +
      "If the repository is private, set MAESTRO_TOKEN to a token that can read it: a private\n" +
      "release's assets are not downloadable without one, and answer 404 rather than 403.",
  );
}

/** Whether this Linux host's own architecture is the one Docker runs. */
function hostArchMatches(arch: "x64" | "arm64"): boolean {
  const host = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
  return host === arch;
}

/**
 * Fetches the release asset, or returns undefined if it cannot.
 *
 * Returns rather than throws so the caller's error can list every option at once; a
 * network failure here is not more interesting than the other two ways to supply a
 * binary, and an operator behind a proxy should see all three.
 */
async function downloadReleaseBinary(opts: {
  arch: "x64" | "arm64";
  version: string;
  cacheDir: string;
  cached: string;
}): Promise<string | undefined> {
  const repo = process.env.MAESTRO_REPO ?? "mustafarslan/maestro";
  const base = process.env.MAESTRO_BASE_URL?.replace(/\/$/, "");
  const asset = `maestro-linux-${opts.arch}`;
  // MAESTRO_TOKEN first, because it is the one `install.sh` documents for this; the
  // GitHub variables are accepted so a machine already configured for the API needs no
  // second secret.
  const token =
    process.env.MAESTRO_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? undefined;

  try {
    let url: string;
    let headers: Record<string, string> = {};
    if (base) {
      url = `${base}/${asset}`;
      if (token) headers.Authorization = `Bearer ${token}`;
    } else if (token) {
      // A PRIVATE repository's release asset cannot be fetched from the browser download
      // URL at all — that path answers 404 even with a valid token, which reads exactly
      // like "this version was never released". It has to be requested through the API by
      // the asset's own id. `install.sh` learned this the same way and says so in a
      // comment; this downloader was written without it and 404'd against a release whose
      // assets were sitting right there.
      const resolved = await resolveAssetUrl({ repo, version: opts.version, asset, token });
      if (!resolved) {
        logger.warn({ repo, version: opts.version, asset }, "release asset not found");
        return undefined;
      }
      url = resolved;
      headers = { Authorization: `Bearer ${token}`, Accept: "application/octet-stream" };
    } else {
      url = `https://github.com/${repo}/releases/download/v${opts.version}/${asset}`;
    }

    logger.info({ url }, "fetching the linux binary for the egress proxy");
    const res = await fetch(url, { redirect: "follow", headers });
    if (!res.ok) {
      logger.warn({ url, status: res.status }, "could not fetch the egress proxy binary");
      return undefined;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    // An HTML error page served with status 200 is the failure `install.sh` learned to
    // catch; the symptom otherwise is `exec format error`, which sends somebody to debug
    // their architecture when their URL was at fault.
    if (!isExecutable(bytes)) {
      logger.warn({ url }, "what was downloaded is not an executable");
      return undefined;
    }
    mkdirSync(opts.cacheDir, { recursive: true });
    const tmp = `${opts.cached}.partial`;
    writeFileSync(tmp, bytes);
    chmodSync(tmp, 0o755);
    // Renamed into place so a crashed or concurrent download never leaves a truncated
    // binary that later looks cached.
    renameSync(tmp, opts.cached);
    return opts.cached;
  } catch (err) {
    logger.warn({ err, repo, asset }, "could not fetch the egress proxy binary");
    return undefined;
  }
}

/**
 * The API URL of one asset on a tagged release.
 *
 * Two requests rather than one because the download URL and the asset id are different
 * things: only the id-addressed API URL serves bytes for a private repository.
 */
async function resolveAssetUrl(opts: {
  repo: string;
  version: string;
  asset: string;
  token: string;
}): Promise<string | undefined> {
  const api = `https://api.github.com/repos/${opts.repo}/releases/tags/v${opts.version}`;
  const res = await fetch(api, {
    headers: {
      Authorization: `Bearer ${opts.token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    logger.warn({ api, status: res.status }, "could not read the release");
    return undefined;
  }
  const body = (await res.json()) as { assets?: { name?: string; url?: string }[] };
  return body.assets?.find((a) => a.name === opts.asset)?.url;
}

/** ELF only: this is a Linux binary or it is not the thing we asked for. */
function isExecutable(bytes: Buffer): boolean {
  return (
    bytes.length > 4 &&
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46
  );
}
