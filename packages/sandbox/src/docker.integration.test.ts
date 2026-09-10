import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EnvSpecSchema } from "@maestro/playbook";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runComparisons } from "./compare.js";
import { DockerSandboxDriver, dockerCommand, listManagedNetworks } from "./docker.js";
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

/**
 * Managed containers on this machine that this test file did not create.
 *
 * A sweep that is not scoped to one review destroys containers it does not own. That
 * means a sweep with no `reviewId` — with or without an age, because an age of one hour
 * is shorter than the two the daemon's own sweep uses, and reviews outlive an hour.
 * daemon can see, which is what `maestro reap` is for and therefore what has to be
 * tested — but the machine running the tests may also be running a review. It was: this
 * suite destroyed the containers of a live review mid-run, and the review carried on
 * calling a model with no sandbox to execute anything in.
 *
 * The hazard was already known here. The comment above the undated-orphan test says an
 * unscoped reap "removes every managed container, including the sandbox the other tests
 * in this file share. A test that damages its neighbours is a worse problem than the one
 * it checks" — and the test below then ran one anyway, protecting only its own review.
 * The guard was written once and not applied to the case that needed it.
 *
 * A destructive sweep now refuses to run rather than taking somebody's review with it.
 */
async function foreignManagedContainers(): Promise<string[]> {
  const out = execFileSync("docker", ["ps", "-aq", "--filter", "label=maestro.managed=true"], {
    encoding: "utf8",
  })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const foreign: string[] = [];
  for (const id of out) {
    const label = execFileSync(
      "docker",
      ["inspect", "--format", '{{index .Config.Labels "maestro.review"}}', id],
      { encoding: "utf8" },
    ).trim();
    if (label !== REVIEW_ID && !label.startsWith(`${REVIEW_ID}-`)) foreign.push(id);
  }
  return foreign;
}

/** Skips a test that would sweep containers it does not own, saying why. */
async function refuseIfNotAlone(): Promise<string | null> {
  const foreign = await foreignManagedContainers();
  return foreign.length
    ? `skipped: ${foreign.length} Maestro container(s) on this machine belong to something else. ` +
        "An unscoped sweep would destroy them, and one of them may be a review in progress."
    : null;
}

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
        // Guarded for the same reason the `protectReviewIds` sweep below is, and it was
        // missed the first time: an hour is not a safe cutoff. The daemon's own periodic
        // sweep uses TWO hours precisely because reviews routinely outlive one, so a
        // review in progress on this machine loses its agent containers and the snapshot
        // image its remaining agents start from. Same hazard, different route.
        const refusal = await refuseIfNotAlone();
        if (refusal) {
          console.log(refusal);
          return;
        }
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
        const refusal = await refuseIfNotAlone();
        if (refusal) {
          console.log(refusal);
          expect((await sandbox.exec("echo still-here")).stdout).toContain("still-here");
          return;
        }
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
        const refusal = await refuseIfNotAlone();
        if (refusal) {
          console.log(refusal);
          expect((await sandbox.exec("echo still-here")).stdout).toContain("still-here");
          return;
        }
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

  itDocker("cannot regain privileges through a setuid binary", async () => {
    // `no-new-privileges` is what makes dropping capabilities stick. Without it a setuid
    // root binary still raises the effective set on exec — and one can arrive legitimately:
    // `prepare` runs the repository's own dependency install, and whatever that writes is
    // baked into the snapshot this container starts from.
    //
    // Read from the kernel rather than from `docker inspect`, because what matters is the
    // state of the process, not the flag we believe we passed. Mutation found this: the
    // three postures beside it were asserted and this one was not, so the flag could have
    // been dropped with the whole suite green.
    const res = await box!.exec("grep NoNewPrivs /proc/self/status");
    expect(res.stdout).toMatch(/NoNewPrivs:\s+1/);
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

  itDocker(
    "replaces the cached checkout instead of merging into it",
    async () => {
      // `docker cp` merges a directory in and never deletes, so the cache-hit path used
      // to analyse `previous UNION current`. Two silent wrongs came out of that: a file
      // the pull request deleted was still there to be reviewed, and a file it ADDED
      // survived into any second checkout taken off the same cache — which is how a
      // base-versus-head comparison can report a command "fixed" when the base it
      // measured already contained the fix.
      //
      // The dependency directories must survive, and not only the top-level one: in a
      // pnpm or yarn workspace they are `packages/*/node_modules` too, and on this path
      // setup does not re-run to restore anything that gets deleted by mistake.
      const reviewId = `${REVIEW_ID}-refresh`;
      const cacheSpec = EnvSpecSchema.parse({
        image: "node:22-bookworm",
        cpus: 2,
        memory: "1GiB",
        timeouts: { prepareSec: 300, analyzeSec: 300, commandSec: 60 },
        // Writes the untracked dependency directories the cache exists to preserve.
        setup: [
          "mkdir -p node_modules packages/a/node_modules && " +
            "touch node_modules/dep-marker packages/a/node_modules/nested-dep-marker",
        ],
        allowedCommands: [],
        // In-process rather than containerised: this test is about the checkout, and the
        // enforced proxy would drag the release binary into an unrelated assertion.
        egressEnforcement: "advisory",
        egressAllowlist: ["registry.npmjs.org"],
      });

      // Identical lockfile bytes on both sides, which is what makes the second prepare a
      // cache hit. Everything else about the two trees differs.
      const lockfile = JSON.stringify({ name: "cache-fixture", lockfileVersion: 3 });
      const commit = (dir: string) => {
        const git = (args: string[]) =>
          execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
        git(["init", "--quiet"]);
        git(["config", "user.email", "test@maestro.local"]);
        git(["config", "user.name", "Maestro Test"]);
        git(["add", "."]);
        git(["commit", "--quiet", "-m", "fixture"]);
      };

      const first = mkdtempSync(join(tmpdir(), "maestro-cache-a-"));
      writeFileSync(join(first, "package.json"), JSON.stringify({ name: "cache-fixture" }));
      writeFileSync(join(first, "package-lock.json"), lockfile);
      writeFileSync(join(first, "removed-by-the-pr.txt"), "from the first checkout\n");
      commit(first);

      const second = mkdtempSync(join(tmpdir(), "maestro-cache-b-"));
      writeFileSync(join(second, "package.json"), JSON.stringify({ name: "cache-fixture" }));
      writeFileSync(join(second, "package-lock.json"), lockfile);
      writeFileSync(join(second, "added-by-the-pr.txt"), "from the second checkout\n");
      commit(second);

      // Recorded rather than recomputed: the deps tag is a hash of inputs the test would
      // have to reconstruct exactly, and a wrong guess here silently leaves a
      // node_modules-sized image on the machine after every run.
      const depsTags = async () =>
        new Set(
          (
            await dockerCommand(
              ["images", "--format", "{{.Repository}}:{{.Tag}}", "maestro/deps"],
              {
                timeoutMs: 30_000,
              },
            )
          ).stdout
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean),
        );
      const before = await depsTags();

      let box2: Sandbox | undefined;
      try {
        const cold = await driver.prepare({ reviewId, sourcePath: first, spec: cacheSpec });
        expect(cold.cacheHit ?? false).toBe(false);

        const warm = await driver.prepare({ reviewId, sourcePath: second, spec: cacheSpec });
        // Without a hit this test would pass vacuously: the cold path builds a correct
        // tree, so it proves nothing about the code under test.
        expect(warm.cacheHit).toBe(true);

        box2 = await driver.analyze(warm, { agentId: "architecture", spec: cacheSpec });
        const ls = async (path: string) =>
          (await box2!.exec(`test -e ${path} && echo yes || echo no`)).stdout.trim();

        // The first checkout's tracked file is gone; the second's is present.
        expect(await ls("removed-by-the-pr.txt")).toBe("no");
        expect(await ls("added-by-the-pr.txt")).toBe("yes");
        // And the dependency layer the cache exists for survived, at both depths.
        expect(await ls("node_modules/dep-marker")).toBe("yes");
        expect(await ls("packages/a/node_modules/nested-dep-marker")).toBe("yes");
      } finally {
        await box2?.destroy();
        await driver.reap({ reviewId });
        // The deps tag outlives the review by design — that is the point of the cache —
        // so only this test can clean it up. Scoped to tags this test created, never a
        // blanket sweep of maestro/deps, which would evict a real repo's warm cache.
        for (const tag of await depsTags()) {
          if (!before.has(tag)) await dockerCommand(["rmi", "-f", tag], { timeoutMs: 60_000 });
        }
        rmSync(first, { recursive: true, force: true });
        rmSync(second, { recursive: true, force: true });
      }
    },
    600_000,
  );
});

describe("base versus head, end to end", () => {
  itDocker(
    "measures a test that genuinely fails at the base and passes at the head",
    async () => {
      // The whole feature in one assertion: a pull request that says "this fixes the
      // failing test" is checkable, because the command was actually run at both refs.
      //
      // The fix is an ADDED file, deliberately. `docker cp` overwrites same-path files,
      // so a fixture whose fix MODIFIES an existing file would still pass even if the
      // base checkout were contaminated by the head tree — the contaminating copy would
      // be the correct base content. Only a file the pull request adds survives into a
      // wrongly-built base tree, so only an added file exercises the hazard.
      const reviewId = `${REVIEW_ID}-compare`;
      const compareSpec = EnvSpecSchema.parse({
        image: "node:22-bookworm",
        cpus: 2,
        memory: "1GiB",
        timeouts: { prepareSec: 300, analyzeSec: 300, commandSec: 60 },
        setup: [],
        allowedCommands: [],
        compareCommands: ["npm test"],
      });

      const write = (dir: string, rel: string, body: string) => {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), body);
      };

      // The test requires a module that exists only at the head.
      const testFile =
        "const { total } = require('./src/cart');\n" +
        "if (total([{price:2},{price:3}]) !== 5) { console.error('wrong total'); process.exit(1); }\n" +
        "console.log('cart total ok');\n";

      const baseDir = mkdtempSync(join(tmpdir(), "maestro-cmp-base-"));
      write(
        baseDir,
        "package.json",
        JSON.stringify({ name: "cmp", scripts: { test: "node test.js" } }),
      );
      write(baseDir, "test.js", testFile);
      // No src/cart.js here: `npm test` cannot resolve it, so it exits non-zero.

      const headDir = mkdtempSync(join(tmpdir(), "maestro-cmp-head-"));
      write(
        headDir,
        "package.json",
        JSON.stringify({ name: "cmp", scripts: { test: "node test.js" } }),
      );
      write(headDir, "test.js", testFile);
      write(
        headDir,
        "src/cart.js",
        "exports.total = (items) => items.reduce((n, i) => n + i.price, 0);\n",
      );

      let baseEnv: PreparedEnvironment | undefined;
      let headEnv: PreparedEnvironment | undefined;
      try {
        baseEnv = await driver.prepare({ reviewId, sourcePath: baseDir, spec: compareSpec });
        headEnv = await driver.prepare({ reviewId, sourcePath: headDir, spec: compareSpec });

        const [result] = await runComparisons(
          {
            headEnv,
            baseEnv,
            commands: compareSpec.compareCommands,
            spec: compareSpec,
          },
          { driver, sampleLoad: () => 0 },
        );

        expect(result?.base?.exitCode).not.toBe(0);
        expect(result?.head?.exitCode).toBe(0);
        expect(result?.verdict).toBe("fixed");
        // Output is carried for a human and the agents to read, never turned into a verdict.
        expect(result?.head?.stdoutTail).toContain("cart total ok");
      } finally {
        await driver.reap({ reviewId });
        rmSync(baseDir, { recursive: true, force: true });
        rmSync(headDir, { recursive: true, force: true });
      }
    },
    600_000,
  );

  itDocker(
    "reports the same command as unchanged when the change does not affect it",
    async () => {
      // The other half of honest reporting: a comparison that finds nothing must say so,
      // rather than reaching for a timing difference to have something to report.
      const reviewId = `${REVIEW_ID}-cmp-same`;
      const sameSpec = EnvSpecSchema.parse({
        image: "node:22-bookworm",
        cpus: 2,
        memory: "1GiB",
        timeouts: { prepareSec: 300, analyzeSec: 300, commandSec: 60 },
        setup: [],
        allowedCommands: [],
        compareCommands: ["npm test"],
      });

      const make = (dir: string, note: string) => {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "cmp", scripts: { test: "node test.js" } }),
        );
        writeFileSync(join(dir, "test.js"), `console.log('ok ${note}');\n`);
      };
      const a = mkdtempSync(join(tmpdir(), "maestro-same-a-"));
      const b = mkdtempSync(join(tmpdir(), "maestro-same-b-"));
      make(a, "one");
      make(b, "two");

      try {
        const baseEnv = await driver.prepare({ reviewId, sourcePath: a, spec: sameSpec });
        const headEnv = await driver.prepare({ reviewId, sourcePath: b, spec: sameSpec });
        const [result] = await runComparisons(
          { headEnv, baseEnv, commands: ["npm test"], spec: sameSpec },
          { driver },
        );
        expect(result?.verdict).toBe("same-exit");
        // Different output, identical exit code, and no verdict drawn from the difference.
        expect(result?.base?.stdoutTail).toContain("ok one");
        expect(result?.head?.stdoutTail).toContain("ok two");
      } finally {
        await driver.reap({ reviewId });
        rmSync(a, { recursive: true, force: true });
        rmSync(b, { recursive: true, force: true });
      }
    },
    600_000,
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

/**
 * Whether the prepare-phase allowlist is a control or a request.
 *
 * Finding 143, made testable. The advisory posture points the sandbox at a proxy with
 * `HTTP_PROXY` and trusts it to comply; anything ignoring those variables — and Node's
 * own `fetch` is one such thing, which is what makes it the right probe — reaches the
 * internet directly. The enforced posture puts the sandbox on an `--internal` network
 * with no route and no external DNS, so the same call reaches nothing.
 *
 * The probe runs as a SETUP COMMAND, inside the real prepare container, because that is
 * the only place the question can honestly be asked. Reading the flags passed to
 * `docker create` would assert that the code does what the code says.
 *
 * These live in this file rather than beside themselves because two real-Docker files
 * running in parallel each see the other's containers as foreign, and the guard above —
 * which exists to stop this suite destroying a live review — then fires against a
 * neighbour instead. One file is one worker, and therefore sequential.
 */
/** Node's fetch ignores HTTP_PROXY entirely, so this is a genuinely direct connection. */
const DIRECT_PROBE =
  "node -e \"fetch('https://registry.npmjs.org/',{signal:AbortSignal.timeout(8000)})" +
  ".then(r=>console.log('DIRECT_REACHED_'+r.status))" +
  ".catch(()=>console.log('DIRECT_BLOCKED'))\"";

/** curl honours the proxy variables, so this exercises the allowed route. */
const VIA_PROXY_ALLOWED =
  "curl -sS -o /dev/null -w 'PROXY_ALLOWED_%{http_code}\\n' -m 25 https://registry.npmjs.org/ || echo PROXY_ALLOWED_FAILED";

const VIA_PROXY_DENIED =
  "curl -sS -o /dev/null -w 'PROXY_DENIED_%{http_code}\\n' -m 25 https://example.com/ || echo PROXY_DENIED_REFUSED";

function specWith(enforcement: "enforced" | "advisory") {
  return EnvSpecSchema.parse({
    image: "node:22-bookworm",
    cpus: 2,
    memory: "1GiB",
    timeouts: { prepareSec: 420, analyzeSec: 120, commandSec: 90 },
    setup: [DIRECT_PROBE, VIA_PROXY_ALLOWED, VIA_PROXY_DENIED],
    allowedCommands: [],
    egressAllowlist: ["registry.npmjs.org"],
    egressEnforcement: enforcement,
  });
}

beforeAll(async () => {
  dockerUp = await driver.available();
  if (!dockerUp) return;
  sourceDir = mkdtempSync(join(tmpdir(), "maestro-egress-src-"));
  writeFileSync(join(sourceDir, "package.json"), JSON.stringify({ name: "fixture" }));
  const git = (args: string[]) =>
    execFileSync("git", ["-C", sourceDir, ...args], { stdio: "ignore" });
  git(["init", "--quiet"]);
  git(["config", "user.email", "test@maestro.local"]);
  git(["config", "user.name", "Maestro Test"]);
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "fixture"]);
}, 120_000);

afterAll(async () => {
  if (sourceDir) rmSync(sourceDir, { recursive: true, force: true });
});

async function runPrepare(enforcement: "enforced" | "advisory") {
  const reviewId = `rv_egress_${enforcement}_${Date.now()}`;
  const env = await driver.prepare({
    reviewId,
    sourcePath: sourceDir,
    spec: specWith(enforcement),
  });
  const output = env.setupResults.map((r) => `${r.stdout}\n${r.stderr}`).join("\n");
  await driver.reap({ reviewId });
  return { env, output };
}

describe("prepare-phase egress enforcement", () => {
  it("enforced: a direct connection that ignores HTTP_PROXY reaches nothing", async () => {
    if (!dockerUp) return;
    const { env, output } = await runPrepare("enforced");

    // The whole point. Under advisory this same line prints DIRECT_REACHED_200.
    expect(output).toContain("DIRECT_BLOCKED");
    expect(output).not.toContain("DIRECT_REACHED");

    // And the allowed route still works, or "enforcement" would just mean "broken".
    expect(output).toContain("PROXY_ALLOWED_200");

    // A host off the allowlist is refused even through the proxy.
    expect(output).toMatch(/PROXY_DENIED_(REFUSED|000|403)/);

    // The refusal is reported, and reported as enforced.
    expect(env.egressEnforcement).toBe("enforced");
    expect(env.egressLog.some((e) => !e.allowed && e.host.includes("example.com"))).toBe(true);
  }, 900_000);

  it("advisory: the same direct connection reaches the internet, which is the gap", async () => {
    if (!dockerUp) return;
    // Not a bug being asserted — a documented posture. This test exists so the two
    // cannot silently become the same thing: if enforcement ever stopped working, the
    // test above would fail and this one would still pass, and the pair says which.
    const { env, output } = await runPrepare("advisory");
    expect(output).toContain("DIRECT_REACHED_");
    expect(env.egressEnforcement).toBe("advisory");
  }, 900_000);

  it("gives a prepare phase with nothing to install no network at all", async () => {
    if (!dockerUp) return;
    // The fork case. An untrusted pull request runs no setup, so the phase that exists to
    // run a stranger's dependency installer has nothing to install — and a network it
    // cannot use is still a network.
    //
    // Asserted from the outside, because there is nothing running on the inside to ask:
    // no proxy container and no review network were created, the reported posture is
    // `none` rather than a proxy that happened to see no traffic, and the analyze
    // container off the resulting snapshot still has no route.
    const reviewId = `rv_egress_nonet_${Date.now()}`;
    const spec = EnvSpecSchema.parse({
      image: "node:22-bookworm",
      cpus: 2,
      memory: "1GiB",
      timeouts: { prepareSec: 420, analyzeSec: 120, commandSec: 90 },
      setup: [],
      allowedCommands: [],
      egressAllowlist: ["registry.npmjs.org"],
      egressEnforcement: "enforced",
    });
    const env = await driver.prepare({ reviewId, sourcePath: sourceDir, spec });
    try {
      // No proxy container and no review network were created for it.
      const nets = await listManagedNetworks();
      expect(nets.filter((n) => n.reviewId === reviewId)).toEqual([]);
      // And it reports the stronger posture rather than claiming an allowlist applied.
      expect(env.egressEnforcement).toBe("none");
      expect(env.egressLog).toEqual([]);

      // The analyze container off that snapshot still has no route, which is the
      // property the whole design rests on and is unchanged by this.
      const box = await driver.analyze(env, { spec });
      try {
        const route = await box.exec("ip route 2>/dev/null || true");
        expect(route.stdout).not.toMatch(/default via/);
      } finally {
        await box.destroy();
      }
    } finally {
      await driver.reap({ reviewId });
    }
  }, 900_000);

  it("fails the prepare phase rather than quietly falling back to advisory", async () => {
    if (!dockerUp) return;
    // The failure mode this must never have. A supply-chain control that stops enforcing
    // without saying so is worse than one that was never claimed: everything downstream —
    // the review comment, the metrics block, the egress log — still reports that the
    // allowlist applied, so nobody finds out.
    const original = process.env.MAESTRO_PROXY_BINARY;
    process.env.MAESTRO_PROXY_BINARY = "/nonexistent/maestro-linux";
    const reviewId = `rv_egress_failclosed_${Date.now()}`;
    try {
      await expect(
        driver.prepare({ reviewId, sourcePath: sourceDir, spec: specWith("enforced") }),
      ).rejects.toThrow(/MAESTRO_PROXY_BINARY/);
    } finally {
      if (original === undefined) delete process.env.MAESTRO_PROXY_BINARY;
      else process.env.MAESTRO_PROXY_BINARY = original;
      await driver.reap({ reviewId });
    }

    // And it left nothing behind on the way out.
    const nets = await listManagedNetworks();
    expect(nets.filter((n) => n.reviewId === reviewId)).toEqual([]);
  }, 300_000);

  it("leaves no network behind", async () => {
    if (!dockerUp) return;
    // Networks are invisible in `docker ps`, so a leak here is the kind nobody notices.
    const leftovers = await listManagedNetworks();
    const ours = leftovers.filter((n) => n.reviewId?.startsWith("rv_egress_"));
    expect(ours).toEqual([]);
  }, 120_000);
});
