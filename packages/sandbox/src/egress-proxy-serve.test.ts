import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROXY_LOG_PATH, PROXY_READY_PATH, serveEgressProxy } from "./egress-proxy.js";

/**
 * The containerised proxy.
 *
 * These exercise the process the enforced prepare phase runs: it must apply the same
 * allowlist as the in-process one, leave a log the daemon can copy out after the
 * container has stopped, and signal readiness before anything dials it. Each of those is
 * load-bearing — a proxy that is not ready yet gives package managers ECONNREFUSED,
 * which most of them do not retry, and the review then fails with a network error that
 * looks nothing like the allowlist.
 */
describe("serveEgressProxy", () => {
  const dirs: string[] = [];
  const stops: (() => void)[] = [];

  afterEach(async () => {
    for (const stop of stops.splice(0)) stop();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /**
   * A request in the shape a proxy actually receives.
   *
   * `fetch` cannot make one: the request URI must be absolute (`GET http://host/ HTTP/1.1`),
   * and `host` is a forbidden header it refuses to set. Written with fetch first, this
   * suite passed while the proxy saw `127.0.0.1` — a 403 for the wrong host, which is
   * the vacuous-guard shape this project keeps finding.
   */
  function viaProxy(port: number, url: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "GET", path: url }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  async function start(allowlist: string[]) {
    const dir = mkdtempSync(join(tmpdir(), "maestro-proxy-"));
    dirs.push(dir);
    const logPath = join(dir, "egress.json");
    const readyPath = join(dir, "ready");

    let port = 0;
    const done = serveEgressProxy({
      allowlist,
      // 0 asks the OS for a free port; concurrent test files must not collide.
      port: 0,
      logPath,
      readyPath,
      onListening: (p) => {
        port = p;
      },
    });
    // serveEgressProxy resolves its listen promise internally before awaiting shutdown,
    // so wait for the callback rather than for the returned promise, which only settles
    // when the proxy stops.
    await new Promise<void>((resolve) => {
      const tick = () => (port ? resolve() : setTimeout(tick, 5));
      tick();
    });
    stops.push(() => process.emit("SIGTERM"));
    return { port, logPath, readyPath, done };
  }

  it("writes the readiness marker only once it is actually accepting connections", async () => {
    const { port, readyPath } = await start(["registry.npmjs.org"]);
    expect(existsSync(readyPath)).toBe(true);
    // And the socket really is up: the marker must not be a promise about the future.
    const res = await viaProxy(port, "http://blocked.example.com/");
    expect(res.status).toBe(403);
    expect(res.body).toContain("blocked.example.com");
  });

  it("refuses a host that is not on the allowlist, and says which", async () => {
    const { port } = await start(["registry.npmjs.org"]);
    const res = await viaProxy(port, "http://evil.example.com/");
    expect(res.status).toBe(403);
    expect(res.body).toContain("evil.example.com");
  });

  it("records refusals to the log file, which is what the daemon copies out", async () => {
    const { port, logPath } = await start(["registry.npmjs.org"]);
    await viaProxy(port, "http://evil.example.com/");
    // The snapshot is debounced, so wait for it rather than assuming an interval boundary.
    await new Promise<void>((resolve) => {
      const started = Date.now();
      const tick = () => {
        const entries = JSON.parse(readFileSync(logPath, "utf8"));
        if (entries.length > 0 || Date.now() - started > 5_000) resolve();
        else setTimeout(tick, 50);
      };
      tick();
    });
    const entries = JSON.parse(readFileSync(logPath, "utf8"));
    expect(entries).toContainEqual(
      expect.objectContaining({ host: "evil.example.com", allowed: false, count: 1 }),
    );
  });

  it("lets an allowlisted host through to the network, rather than refusing everything", async () => {
    // Every other test here asserts a refusal, so a proxy that denied EVERYTHING would
    // pass all of them — the allowlist would be enforced by being useless. This needs no
    // network: `.invalid` is reserved and cannot resolve, so the request reaches the
    // upstream attempt and fails there. 502 means allowed-then-failed; 403 means refused.
    const { port } = await start(["allowed.invalid"]);
    const res = await viaProxy(port, "http://allowed.invalid/");
    expect(res.status).toBe(502);
    expect(res.status).not.toBe(403);
  });

  it("writes an empty log immediately, so a prepare that never reached the network still has one", async () => {
    // Copying a file that does not exist fails, and the failure would arrive during
    // teardown of an otherwise successful review.
    const { logPath } = await start(["registry.npmjs.org"]);
    expect(JSON.parse(readFileSync(logPath, "utf8"))).toEqual([]);
  });

  it("puts its files where the daemon looks for them", () => {
    // These two constants are a contract with docker.ts, which copies from these exact
    // paths inside the container. A rename on one side only would break teardown.
    expect(PROXY_LOG_PATH).toBe("/tmp/egress.json");
    expect(PROXY_READY_PATH).toBe("/tmp/ready");
  });
});
