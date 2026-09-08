import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connect as netConnect } from "node:net";
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

  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const port = (server.address() as AddressInfo).port;
  logger.debug({ port, allowlist }, "egress proxy listening");

  return {
    port,
    log,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
