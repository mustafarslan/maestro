import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connect as netConnect } from "node:net";
import { networkInterfaces } from "node:os";
import { logger } from "@maestro/core";

/**
 * Egress allowlist for the prepare phase.
 *
 * Installing a stranger's dependencies is arbitrary code execution, so `prepare` is the
 * one phase with any network at all. This proxy is the control that makes that
 * acceptable: the container gets no route of its own, only HTTP(S)_PROXY pointing here,
 * and anything off the allowlist is refused.
 *
 * It must handle BOTH verbs. `CONNECT` covers https, but npm/pip also issue plain HTTP
 * requests through a proxy and registries redirect — blocking only CONNECT would leave
 * a hole wide enough to exfiltrate through.
 */

export interface EgressProxy {
  port: number;
  /** Address the proxy is bound to; containers must reach it at this host. */
  host: string;
  /**
   * Every host asked for, allowed or not, with how many times — attached to the review.
   *
   * Aggregated rather than appended. One entry per request meant a dependency install
   * produced thousands: `npm ci` fetches nearly everything from one host, so a project
   * with 1500 dependencies left ~3000 near-identical rows, around 600KB at 5000
   * dependencies, held for the whole review and multiplied by every concurrent review.
   * None of it was information — "registry.npmjs.org, allowed" three thousand times says
   * exactly what a count says — and nothing downstream read the timestamps.
   */
  readonly log: {
    host: string;
    allowed: boolean;
    count: number;
    firstAt: string;
    lastAt: string;
  }[];
  close(): Promise<void>;
}

function hostAllowed(host: string, allowlist: string[]): boolean {
  const bare = host.toLowerCase().split(":")[0] ?? "";
  return allowlist.some((entry) => {
    const e = entry.toLowerCase().replace(/^\*\./, "");
    // Exact match or a subdomain of an allowlisted domain. Substring matching would
    // let "registry.npmjs.org.evil.com" through.
    return bare === e || bare.endsWith(`.${e}`);
  });
}

/**
 * Where to bind the proxy.
 *
 * Binding 0.0.0.0 would leave an open proxy to the allowlisted hosts on the local
 * network for the duration of every prepare phase. Docker Desktop reaches host loopback
 * through host.docker.internal, so macOS binds 127.0.0.1; on Linux the container reaches
 * the host over the bridge gateway, so bind that specific address rather than everything.
 */
function bindAddress(): string {
  if (process.env.MAESTRO_PROXY_BIND) return process.env.MAESTRO_PROXY_BIND;

  // Running inside a container (the Compose deployment), sandboxes are siblings on the
  // HOST daemon and cannot reach this container's loopback. Binding all interfaces is
  // the only address they can reach, and the container's own network namespace is the
  // isolation boundary. MAESTRO_PROXY_HOST must then tell them where to dial.
  if (runningInContainer()) return "0.0.0.0";

  if (process.platform === "darwin") return "127.0.0.1";

  // Linux: prefer the docker0 gateway; fall back to loopback and let the caller's
  // --add-host=host-gateway mapping decide.
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    if (!name.startsWith("docker")) continue;
    const ipv4 = interfaces[name]?.find((a) => a.family === "IPv4" && !a.internal);
    if (ipv4) return ipv4.address;
  }
  return "127.0.0.1";
}

/** True when this process is itself inside a container. */
export function runningInContainer(): boolean {
  if (existsSync("/.dockerenv")) return true;
  try {
    return /docker|containerd|kubepods/.test(readFileSync("/proc/1/cgroup", "utf8"));
  } catch {
    return false;
  }
}

/**
 * The allowlist server itself, with no opinion about where it runs.
 *
 * Two callers now: `startEgressProxy`, which binds it inside the daemon and is the
 * advisory posture; and `serveEgressProxy`, which is what runs inside the proxy
 * container when the allowlist is enforced. They must apply the identical rule — an
 * enforced proxy that allowed a host the advisory one refused, or the reverse, would
 * make the enforcement mode change what a review is allowed to fetch. One function, so
 * that cannot drift.
 */
function createEgressServer(
  allowlist: string[],
  record: (host: string, allowed: boolean) => void,
): Server {
  const server: Server = createServer((req, res) => {
    // Plain HTTP through the proxy: the absolute-form request URI carries the host.
    let target: URL;
    try {
      target = new URL(req.url ?? "", `http://${req.headers.host ?? ""}`);
    } catch {
      res.writeHead(400).end("bad request");
      return;
    }
    const allowed = hostAllowed(target.host, allowlist);
    record(target.host, allowed);
    if (!allowed) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end(`maestro: egress to ${target.host} is not on the allowlist\n`);
      return;
    }

    const upstream = httpRequest(
      {
        host: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: req.headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on("error", () => res.writeHead(502).end("upstream error"));
    req.pipe(upstream);
  });

  // HTTPS tunnelling.
  server.on("connect", (req, clientSocket, head) => {
    const host = req.url ?? "";
    const allowed = hostAllowed(host, allowlist);
    record(host, allowed);
    if (!allowed) {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const [hostname, portStr] = host.split(":");
    const upstream = netConnect(Number(portStr ?? 443), hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
    clientSocket.on("error", () => upstream.destroy());
  });

  return server;
}

/**
 * Aggregates hosts asked for, allowed or not.
 *
 * Shared by both modes for the same reason the server is: the review comment renders
 * this, and a count that meant different things in the two postures would be worse than
 * no count.
 */
function createRecorder(log: EgressProxy["log"]): (host: string, allowed: boolean) => void {
  return (rawHost, allowed) => {
    // CONNECT carries "host:443" and a plain GET carries "host", so the same registry
    // appeared as two rows and the review comment listed it twice. The allowlist already
    // matches on the bare host; the log now agrees with it. A non-default port is kept,
    // because "something dialled :8080" is worth seeing.
    const host = rawHost.replace(/:(80|443)$/, "");
    const at = new Date().toISOString();
    // Bounded by the number of distinct hosts, which is small, rather than by the number
    // of requests, which is one per package.
    const seen = log.find((e) => e.host === host && e.allowed === allowed);
    if (seen) {
      seen.count++;
      seen.lastAt = at;
    } else {
      log.push({ host, allowed, count: 1, firstAt: at, lastAt: at });
    }
    // Still one line per blocked ATTEMPT: a refusal is worth seeing every time it happens,
    // and there are few of them by construction.
    if (!allowed) logger.warn({ host }, "egress blocked");
  };
}

export async function startEgressProxy(allowlist: string[]): Promise<EgressProxy> {
  const log: EgressProxy["log"] = [];
  const server = createEgressServer(allowlist, createRecorder(log));

  const host = bindAddress();
  const port = await listenOnAvailablePort(server, host);
  logger.debug({ host, port, allowlist }, "egress proxy listening");

  return {
    port,
    host,
    log,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * Binds the proxy, honouring a fixed port range when one is configured.
 *
 * An ephemeral port is right for a local install, and wrong inside Compose: a port that
 * is chosen at review time cannot have been published in the compose file, so sibling
 * sandboxes dial the bridge gateway and find nothing listening. A RANGE rather than a
 * single port because concurrent reviews each run their own proxy — one fixed port
 * would serialise the thing the scheduler exists to parallelise.
 */
async function listenOnAvailablePort(server: Server, host: string): Promise<number> {
  const candidates = portCandidates();
  if (candidates.length === 0) {
    await new Promise<void>((resolve) => server.listen(0, host, resolve));
    return (server.address() as AddressInfo).port;
  }

  for (const candidate of candidates) {
    const bound = await new Promise<boolean>((resolve) => {
      const onError = () => resolve(false);
      server.once("error", onError);
      server.listen(candidate, host, () => {
        server.removeListener("error", onError);
        resolve(true);
      });
    });
    if (bound) return candidate;
  }

  throw new Error(
    `No free port in MAESTRO_PROXY_PORT_RANGE (${candidates[0]}-${candidates[candidates.length - 1]}). ` +
      "Every port in the range is in use, which caps concurrent prepare phases — widen the range " +
      "and publish the same range in docker-compose.yml.",
  );
}

/** Parses MAESTRO_PROXY_PORT_RANGE ("7790-7799" or a single "7790"); empty means ephemeral. */
function portCandidates(): number[] {
  const raw = process.env.MAESTRO_PROXY_PORT_RANGE?.trim();
  if (!raw) return [];
  const match = /^(\d+)(?:-(\d+))?$/.exec(raw);
  if (!match) {
    throw new Error(`MAESTRO_PROXY_PORT_RANGE must be "PORT" or "START-END", got "${raw}"`);
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : start;
  if (end < start || start < 1 || end > 65535) {
    throw new Error(`MAESTRO_PROXY_PORT_RANGE "${raw}" is not a valid port range`);
  }
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

/**
 * Where the containerised proxy leaves its state for the daemon to collect.
 *
 * A file rather than stdout. The obvious design was to print the log and read it back
 * with `docker logs`, but this process also writes pino lines to stdout — one per
 * blocked attempt — so the two would interleave and the parse would depend on nothing
 * else ever logging. A file has no such coupling, `docker cp` reads it out of a
 * container that has already exited, and a hard kill still leaves the last snapshot.
 */
export const PROXY_LOG_PATH = "/tmp/egress.json";

/**
 * Written once the socket is accepting connections, and polled by the daemon.
 *
 * Without it the prepare container can start first and a package manager gets
 * ECONNREFUSED, which most of them do not retry — so the review fails with a network
 * error that looks like the allowlist rejecting something it never saw.
 */
export const PROXY_READY_PATH = "/tmp/ready";

/**
 * Runs the proxy as the container's main process.
 *
 * Binds every interface deliberately, which is the opposite of `bindAddress()`'s
 * reasoning and correct here: this process is alone in a container attached to one
 * `--internal` network, so "every interface" is that network and nothing else. The
 * isolation boundary is the network, not the bind address.
 *
 * Resolves when the process has been asked to stop, having written a final snapshot.
 */
export async function serveEgressProxy(opts: {
  allowlist: string[];
  port: number;
  /** Overridable so tests need not write to the host's /tmp; the container uses the default. */
  logPath?: string;
  readyPath?: string;
  /** Resolves once listening, so a test can drive the proxy without racing it. */
  onListening?: (port: number) => void;
}): Promise<void> {
  const logPath = opts.logPath ?? PROXY_LOG_PATH;
  const readyPath = opts.readyPath ?? PROXY_READY_PATH;
  const log: EgressProxy["log"] = [];
  const record = createRecorder(log);
  let dirty = false;
  const server = createEgressServer(opts.allowlist, (host, allowed) => {
    record(host, allowed);
    dirty = true;
  });

  // Written to a temporary name and renamed, so a `docker cp` that races a write reads
  // either the previous snapshot or the new one, never half of one.
  const snapshot = () => {
    try {
      const tmp = `${logPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(log));
      renameSync(tmp, logPath);
    } catch (err) {
      logger.warn({ err }, "could not write the egress log");
    }
  };
  snapshot();

  await new Promise<void>((resolve) => {
    server.listen(opts.port, "0.0.0.0", () => {
      try {
        writeFileSync(readyPath, "ready");
      } catch (err) {
        logger.warn({ err }, "could not write the readiness marker");
      }
      const bound = (server.address() as AddressInfo).port;
      logger.info({ port: bound, allowlist: opts.allowlist }, "egress proxy listening");
      opts.onListening?.(bound);
      resolve();
    });
  });

  // Debounced rather than written per request: `npm ci` on a large project asks for one
  // host a few thousand times, and rewriting the file that often is pure syscall.
  const ticker = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    snapshot();
  }, 1_000);

  await new Promise<void>((resolve) => {
    const stop = () => {
      clearInterval(ticker);
      snapshot();
      server.closeAllConnections?.();
      server.close(() => resolve());
      // A prepare phase that is being torn down has connections in flight; do not wait
      // for them to drain past the point where the daemon has stopped caring.
      setTimeout(resolve, 2_000).unref();
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  });
  snapshot();
}
