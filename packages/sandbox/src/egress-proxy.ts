import { existsSync, readFileSync } from "node:fs";
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
  /** Every host asked for, allowed or not — attached to the review for auditing. */
  readonly log: { host: string; allowed: boolean; at: string }[];
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

export async function startEgressProxy(allowlist: string[]): Promise<EgressProxy> {
  const log: EgressProxy["log"] = [];
  const record = (host: string, allowed: boolean) => {
    log.push({ host, allowed, at: new Date().toISOString() });
    if (!allowed) logger.warn({ host }, "egress blocked");
  };

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
