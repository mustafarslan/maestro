import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { SqlDatabase } from "@maestro/core";
import { logger } from "@maestro/core";
import { authorize, handleApi } from "./api.js";
import { listen } from "./listen.js";
import { UI_ASSETS } from "./ui-assets.generated.js";

export interface AdminServerOptions {
  db: SqlDatabase;
  port: number;
  host?: string;
  token: string;
}

export interface RunningAdmin {
  port: number;
  broadcast: (event: string, data: unknown) => void;
  close(): Promise<void>;
}

/**
 * Admin API + embedded UI.
 *
 * Binds to loopback by default and always requires a token. This is deliberately a
 * different listener from the webhook receiver: the webhook endpoint has to be reachable
 * from the internet, and serving the admin surface from the same port would publish the
 * review board and the playbook editor alongside it.
 */
export async function startAdminServer(opts: AdminServerOptions): Promise<RunningAdmin> {
  const host = opts.host ?? "127.0.0.1";
  const clients = new Set<import("node:http").ServerResponse>();

  const broadcast = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${host}`);

      // Server-sent events: one direction is all the UI needs, and EventSource
      // reconnects on its own, which a WebSocket would make us implement.
      if (url.pathname === "/api/events") {
        if (!authorize(req, opts.token)) {
          res.writeHead(401).end();
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write("event: hello\ndata: {}\n\n");
        clients.add(res);
        // Proxies drop idle connections; a periodic comment keeps the stream alive.
        const keepAlive = setInterval(() => {
          try {
            res.write(": keep-alive\n\n");
          } catch {
            clearInterval(keepAlive);
          }
        }, 25_000);
        req.on("close", () => {
          clearInterval(keepAlive);
          clients.delete(res);
        });
        return;
      }

      if (await handleApi({ db: opts.db, token: opts.token, broadcast }, req, res)) return;

      // Static UI. Unknown paths fall through to index.html so client-side routing works.
      const assetPath = url.pathname === "/" ? "/index.html" : url.pathname;
      const exact = UI_ASSETS[assetPath];

      // A missing file under /assets/ is a stale URL, not a route. Falling it through to
      // index.html answered 200 with HTML for a request the browser made for a script,
      // which surfaces as a confusing MIME error instead of a plain 404 — and, with the
      // caching below, pinned that answer for a year.
      if (!exact && assetPath.startsWith("/assets/")) {
        res.writeHead(404).end("not found");
        return;
      }

      const asset = exact ?? UI_ASSETS["/index.html"];
      if (!asset) {
        res.writeHead(404).end("ui not embedded; run scripts/embed-ui.mjs");
        return;
      }

      // Immutable ONLY for a file that exists under its content-hashed name. The test used
      // to be `assetPath === "/index.html"`, so every client-side route — `/quality`,
      // `/studio`, anything the SPA owns — took the immutable branch and was cached for a
      // year while actually being index.html. After an upgrade, a browser sitting on
      // `/quality` would keep serving the old index from cache, pointing at asset hashes
      // that no longer exist: a UI broken until someone thought to hard-reload. Found by
      // serving the compiled binary and asking for a route, which no unit test does.
      const immutable = exact !== undefined && assetPath !== "/index.html";
      res.writeHead(200, {
        "content-type": asset.mime,
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store",
        "x-content-type-options": "nosniff",
        // The admin token arrives in the query string, so anything this page can reach
        // off-origin is a way to hand that token to someone else in a Referer header. It
        // reaches nothing: the UI is embedded, its script and stylesheet are same-origin
        // files, and the policy says so instead of trusting that it stays that way.
        // `style-src` allows inline because a component library may inject a <style> tag
        // at runtime; scripts get no such exemption.
        "referrer-policy": "no-referrer",
        "content-security-policy": [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data:",
          "connect-src 'self'",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join("; "),
      });
      res.end(Buffer.from(asset.body, "base64"));
    })().catch((err) => {
      logger.error({ err }, "admin request failed");
      if (!res.headersSent) res.writeHead(500).end("internal error");
    });
  });

  await listen(server, opts.port, host, "admin server");
  const port = (server.address() as AddressInfo).port;
  logger.info({ host, port }, "admin server listening");

  return {
    port,
    broadcast,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of clients) c.end();
        clients.clear();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
