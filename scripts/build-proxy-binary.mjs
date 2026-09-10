#!/usr/bin/env node
/**
 * Cross-compiles the Linux binary that runs inside the egress-proxy container.
 *
 * Separate from `build:binary`, and deliberately not part of the gate: it roughly doubles
 * build time, and the gate already runs the host build. This is what a macOS developer
 * runs once so the enforced prepare phase has a Linux binary to copy into a container.
 *
 * The architecture that matters is DOCKER'S, not the host's — Docker Desktop can run a
 * different one, and a binary built for the wrong architecture fails as
 * `exec format error` at review time rather than here.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Bun is not on the default PATH of a login shell that did not source the profile, which
 * is every non-interactive invocation of this script. `scripts/gate.sh` already prepends
 * this directory for the same reason; resolving it here means the two agree.
 */
function bunPath() {
  const installed = join(homedir(), ".bun", "bin", "bun");
  if (existsSync(installed)) return installed;
  return "bun";
}

const BUN_TARGETS = {
  arm64: "bun-linux-aarch64",
  aarch64: "bun-linux-aarch64",
  amd64: "bun-linux-x64",
  x86_64: "bun-linux-x64",
};

function dockerArch() {
  try {
    return execFileSync("docker", ["version", "--format", "{{.Server.Arch}}"], {
      encoding: "utf8",
    }).trim();
  } catch {
    // No daemon: fall back to this host's architecture and say so, rather than refusing
    // to build. The binary is still useful; it just may not be the one Docker wants.
    console.warn("could not ask Docker for its architecture; using this host's");
    return process.arch === "arm64" ? "arm64" : "amd64";
  }
}

const arch = dockerArch();
const target = BUN_TARGETS[arch];
if (!target) {
  console.error(`No Bun target for Docker architecture "${arch}".`);
  process.exit(1);
}

const out = `dist/maestro-linux-${arch === "amd64" || arch === "x86_64" ? "x64" : "arm64"}`;
mkdirSync("dist", { recursive: true });

console.log(`building ${out} for Docker (${arch}) with --target=${target}`);
execFileSync(
  bunPath(),
  ["build", "--compile", `--target=${target}`, "--outfile", out, "apps/cli/dist/index.js"],
  { stdio: "inherit" },
);
console.log(`\n  ${out}`);
