import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvSpecSchema } from "@maestro/playbook";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DockerSandboxDriver, dockerCommand } from "./docker.js";
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
  image: "node:22-bookworm",
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
  // A real git repo, so the git tooling assertions below exercise the real path.
  const git = (args: string[]) =>
    execFileSync("git", ["-C", sourceDir, ...args], { stdio: "ignore" });
  git(["init", "--quiet"]);
  git(["config", "user.email", "test@maestro.local"]);
  git(["config", "user.name", "Maestro Test"]);
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "fixture"]);

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
  itDocker(
    "leaves a container it cannot date alone when an age cutoff is given",
    async () => {
      // The first version of the age check skipped it entirely when the created label was
      // missing or unparseable, so exactly those containers were force-removed at any
      // age — reaching the failure the guard exists to prevent through the unlabelled
      // path. A container you cannot date is not provably garbage. Maestro reported this
      // on the commit that introduced it.
      const orphan = `maestro-undated-${Date.now()}`;
      execFileSync("docker", [
        "run",
        "-d",
        "--name",
        orphan,
        "--label",
        "maestro.managed=true",
        "alpine",
        "sleep",
        "120",
      ]);

      try {
        await driver.reap({ olderThanMs: 60 * 60_000 });
        const still = execFileSync("docker", ["ps", "-aq", "--filter", `name=${orphan}`], {
          encoding: "utf8",
        }).trim();
        expect(still, "an undated container was swept by an age-bounded reap").not.toBe("");

        // Deliberately NOT asserting that an unscoped sweep collects it here: an
        // unscoped reap removes every managed container, including the sandbox the other
        // tests in this file share. A test that damages its neighbours is a worse
        // problem than the one it checks.
      } finally {
        execFileSync("docker", ["rm", "-f", orphan], { stdio: "ignore" });
      }
    },
    180_000,
  );

  itDocker(
    "leaves a container younger than the age cutoff alone",
    async () => {
      // `olderThanMs` was accepted and ignored. The daemon's periodic sweep passes a
      // two-hour age and runs every ten minutes, so it deleted containers of every age —
      // including the ones its own reviews were using at that moment.
      const sandbox = await driver.analyze(env!, { spec });
      try {
        const result = await driver.reap({ olderThanMs: 60 * 60_000 });
        expect(result.protected).toBeGreaterThan(0);

        const alive = await sandbox.exec("echo still-here");
        expect(alive.stdout).toContain("still-here");
      } finally {
        await sandbox.destroy();
      }
    },
    180_000,
  );

  itDocker(
    "leaves a protected review's containers alone when reaping",
    async () => {
      // An unscoped sweep matches every Maestro-labelled container, which includes the ones
      // a running daemon is using right now — so `maestro reap` during a review destroyed
      // it, and `doctor` counted those same live containers as leaked and recommended
      // exactly that command.
      const sandbox = await driver.analyze(env!, { spec });
      try {
        const result = await driver.reap({ protectReviewIds: [REVIEW_ID] });
        expect(result.protected).toBeGreaterThan(0);

        // Still alive: the container must actually survive, not merely be counted.
        const alive = await sandbox.exec("echo still-here");
        expect(alive.stdout).toContain("still-here");
      } finally {
        await sandbox.destroy();
      }
    },
    180_000,
  );

  itDocker("keeps the package-manager cache outside the tmpfs that shadows /tmp", async () => {
    // The analyze phase mounts a tmpfs over /tmp, which shadows anything prepare baked in
    // there. With corepack's download under /tmp it was invisible by analyze time, so
    // every allowlisted command exited in 0.1s trying to fetch a package manager with no
    // network — and the agent saw a bare exit 1, indistinguishable from a real failure.
    // Measured on a real pull request: six commands, six instant failures.
    const home = await box!.exec("printenv COREPACK_HOME");
    expect(home.exitCode).toBe(0);
    expect(home.stdout.trim()).not.toMatch(/^\/tmp\b/);

    // The location must survive the commit, not merely be pointed at.
    const survives = await box!.exec(`test -d ${home.stdout.trim()} && echo present`);
    expect(survives.stdout.trim()).toBe("present");
  });

  itDocker("has a working git, which every git tool depends on", async () => {
    // The slim base images ship without git; that silently broke git_diff/git_log and
    // cost every review its diff.
    const version = await box!.exec("git --version");
    expect(version.exitCode).toBe(0);
    expect(version.stdout).toContain("git version");
  });

  itDocker("can run git against the copied checkout despite host file ownership", async () => {
    // Files copied in from the host are owned by the host uid; without an explicit
    // safe.directory git refuses with "dubious ownership".
    const res = await box!.exec("git log --oneline -1");
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim().length).toBeGreaterThan(0);
  });

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

describe("dependency cache", () => {
  itDocker(
    "survives teardown, otherwise the whole caching feature is useless",
    async () => {
      // Regression: the cache tag points at the SAME image id as the review snapshot,
      // so reaping by review label destroyed it on every teardown and no review ever
      // got a cache hit.
      const cachedTag = "maestro/deps:integration-probe";
      await dockerCommand(["tag", env!.imageId, cachedTag], { timeoutMs: 30_000 });
      try {
        await driver.reap({ reviewId: REVIEW_ID });
        const inspect = await dockerCommand(["image", "inspect", cachedTag], { timeoutMs: 20_000 });
        expect(inspect.exitCode).toBe(0);
      } finally {
        await dockerCommand(["rmi", "-f", cachedTag], { timeoutMs: 30_000 });
      }
    },
    240_000,
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

describe("compose deployment wiring", () => {
  const original = process.env.MAESTRO_SANDBOX_NETWORK;
  afterEach(() => {
    if (original === undefined) delete process.env.MAESTRO_SANDBOX_NETWORK;
    else process.env.MAESTRO_SANDBOX_NETWORK = original;
  });

  itDocker(
    "puts the prepare sandbox on a named network when one is configured",
    async () => {
      // Under Compose, Maestro is a container beside its sandboxes, not their host. The
      // first attempt published the proxy on the docker bridge gateway, which is a real
      // interface only on Linux — `docker run -p 172.17.0.1:...` fails outright on Docker
      // Desktop with "can't assign requested address", so the deployment could not even
      // start. Joining a shared network removes the problem instead of working around it.
      const network = `maestro-test-net-${Date.now()}`;
      execFileSync("docker", ["network", "create", network], { stdio: "ignore" });
      process.env.MAESTRO_SANDBOX_NETWORK = network;

      try {
        const env = await driver.prepare({
          reviewId: `${REVIEW_ID}-net`,
          sourcePath: sourceDir!,
          spec: { ...spec, setup: [], allowedCommands: [] },
        });
        expect(env.imageId).toMatch(/^maestro\/snapshot:/);

        // And the analyze phase must still have no network at all: joining prepare to a
        // network must not leak into the phase that reads untrusted code.
        const box2 = await driver.analyze(env, { spec });
        try {
          const route = await box2.exec("ip route 2>/dev/null || true");
          expect(route.stdout).not.toMatch(/default via/);
        } finally {
          await box2.destroy();
        }
      } finally {
        await driver.reap({ reviewId: `${REVIEW_ID}-net` });
        execFileSync("docker", ["network", "rm", network], { stdio: "ignore" });
      }
    },
    300_000,
  );
});
