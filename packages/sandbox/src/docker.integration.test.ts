import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvSpecSchema } from "@maestro/playbook";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerSandboxDriver } from "./docker.js";
import { startEgressProxy } from "./egress-proxy.js";
import type { PreparedEnvironment, Sandbox } from "./types.js";

/**
 * Real-Docker integration tests.
 *
 * The security posture is ASSERTED here, not assumed from the flags passed to `docker
 * run`. A typo in a flag name is silent otherwise, and the whole safety story for
 * running strangers' code rests on these behaving as claimed.
 */

const driver = new DockerSandboxDriver();
let dockerUp = false;
let sourceDir = "";
let env: PreparedEnvironment | undefined;
let box: Sandbox | undefined;

const REVIEW_ID = `rv_test_${Date.now()}`;
const spec = EnvSpecSchema.parse({
  image: "node:22-bookworm-slim",
  cpus: 2,
  memory: "1GiB",
  timeouts: { prepareSec: 300, analyzeSec: 300, commandSec: 60 },
  setup: [],
  allowedCommands: ["auto"],
  egressAllowlist: ["registry.npmjs.org"],
});

beforeAll(async () => {
  dockerUp = await driver.available();
  if (!dockerUp) return;

  sourceDir = mkdtempSync(join(tmpdir(), "maestro-src-"));
  writeFileSync(
    join(sourceDir, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { test: "node -e \"console.log('tests pass')\"" } }),
  );
  writeFileSync(join(sourceDir, "index.js"), "module.exports = 1;\n");

  env = await driver.prepare({ reviewId: REVIEW_ID, sourcePath: sourceDir, spec });
  box = await driver.analyze(env, { agentId: "architecture", spec });
}, 600_000);

afterAll(async () => {
  if (!dockerUp) return;
  await box?.destroy();
  await driver.reap({ reviewId: REVIEW_ID });
  if (sourceDir) rmSync(sourceDir, { recursive: true, force: true });
}, 300_000);

const itDocker = (name: string, fn: () => Promise<void>, timeout = 120_000) =>
  it(
    name,
    async () => {
      if (!dockerUp) {
        console.warn("docker unavailable - skipping integration test");
        return;
      }
      await fn();
    },
    timeout,
  );

describe("prepare phase", () => {
  itDocker("detects the toolchain and derives the command allowlist", async () => {
    expect(env?.toolchain.kind).toBe("node");
    expect(env?.allowedCommands).toContain("npm run test");
  });

  itDocker("produces a snapshot image labelled for the reaper", async () => {
    expect(env?.imageId).toMatch(/^maestro\/snapshot:/);
  });
});

describe("analyze phase security posture", () => {
  itDocker("has the checkout available", async () => {
    const res = await box!.exec("ls package.json index.js");
    expect(res.exitCode).toBe(0);
  });

  itDocker("has NO network access", async () => {
    // The single most important assertion in the suite: an agent reviewing hostile code
    // must not be able to reach the internet.
    const res = await box!.exec("getent hosts registry.npmjs.org || echo NO_DNS");
    expect(res.stdout + res.stderr).toContain("NO_DNS");
  });

  itDocker("cannot reach a host even by raw IP", async () => {
    const res = await box!.exec("timeout 5 bash -c '</dev/tcp/1.1.1.1/443' 2>&1 || echo NO_ROUTE");
    expect(res.stdout + res.stderr).toContain("NO_ROUTE");
  });

  itDocker("has a read-only root filesystem", async () => {
    const res = await box!.exec("touch /etc/maestro-probe 2>&1 || echo READ_ONLY");
    expect(res.stdout + res.stderr).toContain("READ_ONLY");
  });

  itDocker("still allows writes to the tmpfs scratch space", async () => {
    // Tooling needs somewhere to write; that somewhere must be tmpfs, not the image.
    const res = await box!.exec("touch /tmp/ok && echo WROTE");
    expect(res.stdout).toContain("WROTE");
  });

  itDocker("carries no docker socket, so there is no escape to the host daemon", async () => {
    const res = await box!.exec("test -S /var/run/docker.sock && echo SOCKET || echo NO_SOCKET");
    expect(res.stdout).toContain("NO_SOCKET");
  });

  itDocker("exposes no credential-shaped environment variables", async () => {
    const res = await box!.exec("env");
    expect(res.stdout).not.toMatch(/API_KEY|TOKEN=|SECRET|ANTHROPIC|GITHUB_/i);
  });

  itDocker("has dropped capabilities", async () => {
    const res = await box!.exec("cat /proc/self/status | grep CapEff");
    // All capabilities dropped => the effective set is all zeroes.
    expect(res.stdout).toMatch(/CapEff:\s+0+$/m);
  });

  itDocker("kills a command that exceeds its timeout", async () => {
    const res = await box!.exec("sleep 30", { timeoutSec: 2 });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBe(124);
  });

  itDocker("can actually run the repo's test command", async () => {
    const res = await box!.exec("npm run test");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("tests pass");
  });

  itDocker(
    "gives each agent its own container off the same snapshot",
    async () => {
      // Concurrent agents running builds must not clobber one another's working directory.
      const second = await driver.analyze(env!, { agentId: "security", spec });
      try {
        expect(second.containerId).not.toBe(box!.containerId);
        await second.exec("echo isolated > /tmp/marker");
        const mine = await box!.exec("cat /tmp/marker 2>&1 || echo ABSENT");
        expect(mine.stdout + mine.stderr).toContain("ABSENT");
      } finally {
        await second.destroy();
      }
    },
    180_000,
  );
});

describe("egress allowlist proxy", () => {
  /** A real proxy client sends the absolute-form request URI; `fetch` cannot, because
   *  it forbids overriding the Host header. */
  function proxyGet(port: number, target: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method: "GET",
          path: target,
          headers: { host: new URL(target).host },
        },
        (res) => {
          let body = "";
          res.on("data", (d) => {
            body += d;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("refuses a non-allowlisted host over plain HTTP, not just CONNECT", async () => {
    // Blocking only CONNECT would leave a hole wide enough to exfiltrate through:
    // npm and pip both issue plain HTTP through a proxy, and registries redirect.
    const proxy = await startEgressProxy(["registry.npmjs.org"]);
    try {
      const res = await proxyGet(proxy.port, "http://evil.example.com/steal");
      expect(res.status).toBe(403);
      expect(res.body).toContain("not on the allowlist");
      expect(proxy.log.some((e) => e.host === "evil.example.com" && !e.allowed)).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  it("does not treat a lookalike domain as a subdomain match", async () => {
    // Substring matching would let "registry.npmjs.org.evil.com" straight through.
    const proxy = await startEgressProxy(["npmjs.org"]);
    try {
      const res = await proxyGet(proxy.port, "http://npmjs.org.evil.com/");
      expect(res.status).toBe(403);
    } finally {
      await proxy.close();
    }
  });

  it("allows a genuine subdomain of an allowlisted domain", async () => {
    const proxy = await startEgressProxy(["npmjs.org"]);
    try {
      // Reaches the allow branch and then fails upstream (no network in CI is fine);
      // what matters is that it was not refused with a 403.
      const res = await proxyGet(proxy.port, "http://registry.npmjs.org/").catch(() => ({
        status: 0,
        body: "",
      }));
      expect(res.status).not.toBe(403);
      expect(proxy.log.some((e) => e.host === "registry.npmjs.org" && e.allowed)).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  it("refuses a CONNECT tunnel to a non-allowlisted host", async () => {
    const proxy = await startEgressProxy(["registry.npmjs.org"]);
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest({
          host: "127.0.0.1",
          port: proxy.port,
          method: "CONNECT",
          path: "evil.example.com:443",
        });
        // A refused tunnel comes back as a 403 status line and no established tunnel.
        req.on("connect", (res, socket) => {
          socket.destroy();
          resolve(res.statusCode ?? 0);
        });
        req.on("close", () => resolve(0));
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(403);
      expect(proxy.log.some((e) => e.host.startsWith("evil.example.com") && !e.allowed)).toBe(true);
    } finally {
      await proxy.close();
    }
  });
});
