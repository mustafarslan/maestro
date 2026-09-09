/**
 * Toolchain detection.
 *
 * A pure function over a file listing plus file contents, so it is unit-testable without
 * touching Docker or the filesystem. The result drives three things: which base image to
 * use, what `setup: [auto]` expands to, and — critically — what `allowedCommands: [auto]`
 * expands to, since that is the entire set of commands an agent is permitted to run.
 */

export type ToolchainKind = "node" | "python" | "go" | "rust" | "unknown";

export interface Toolchain {
  kind: ToolchainKind;
  /** Base image pinned by the caller's image policy; "auto" resolves through here. */
  image: string;
  packageManager?: string;
  setup: string[];
  commands: {
    test?: string;
    lint?: string;
    build?: string;
    typecheck?: string;
  };
}

export interface RepoSnapshot {
  /** Repo-relative paths present at the root (and a shallow listing is enough). */
  files: string[];
  /** Contents of the few files detection actually reads. */
  read: (path: string) => string | undefined;
}

/**
 * Base images deliberately are NOT the `-slim` variants: those ship without git, which
 * silently breaks git_diff, git_log and git_blame — and the diff is the single most
 * important input an agent has. Paying for a larger image once beats every review
 * losing its diff.
 */
const NODE_IMAGE = "node:22-bookworm";
const PYTHON_IMAGE = "python:3.12-bookworm";
const GO_IMAGE = "golang:1.25-bookworm";
const RUST_IMAGE = "rust:1-bookworm";
const POLYGLOT_IMAGE = "buildpack-deps:bookworm-scm";

export function detectToolchain(snap: RepoSnapshot): Toolchain {
  const has = (f: string) => snap.files.includes(f);

  if (has("package.json")) return detectNode(snap);
  if (has("pyproject.toml") || has("requirements.txt") || has("setup.py"))
    return detectPython(snap);
  if (has("go.mod")) return detectGo();
  if (has("Cargo.toml")) return detectRust();

  return { kind: "unknown", image: POLYGLOT_IMAGE, setup: [], commands: {} };
}

function detectNode(snap: RepoSnapshot): Toolchain {
  const has = (f: string) => snap.files.includes(f);

  // The lockfile is the authority on the package manager: running `npm ci` in a pnpm
  // repo either fails or silently produces a different dependency tree.
  // --ignore-scripts is deliberate. Lifecycle scripts are arbitrary code from a
  // stranger's dependency tree, and in practice they are also the main thing that
  // fails behind an egress allowlist (they fetch binaries from assorted CDNs).
  // Review needs a resolved dependency tree for navigation and type resolution, not
  // working native binaries, so skipping them is both safer and more reliable.
  const [packageManager, install] = has("pnpm-lock.yaml")
    ? ["pnpm", "corepack pnpm install --frozen-lockfile --ignore-scripts"]
    : has("yarn.lock")
      ? ["yarn", "corepack yarn install --immutable --mode=skip-build"]
      : has("bun.lockb") || has("bun.lock")
        ? ["bun", "bun install --frozen-lockfile --ignore-scripts"]
        : has("package-lock.json")
          ? ["npm", "npm ci --ignore-scripts"]
          : ["npm", "npm install --no-audit --no-fund --ignore-scripts"];

  // Corepack ships with the Node images but the packaged manager is not installed until
  // it is activated, and the version matters as much as the activation.
  //
  // `corepack prepare <pm> --activate` fetches the LATEST release. A repo that pins
  // `packageManager` — most do — then hits a shim that wants the pinned version, which is
  // not in the cache, and tries to download it. The analyze phase has no network, so every
  // allowlisted command died in 0.1s with a fetch error that reached the agent as a plain
  // exit 1. Agents were reporting on repositories they could not actually build.
  //
  // `corepack install` with no arguments reads `packageManager` from package.json and
  // caches exactly that version, during prepare, while there is still a network. Verified
  // offline afterwards: lint and typecheck both exit 0 where they previously exited 1.
  const activate =
    packageManager === "npm"
      ? []
      : [`corepack enable && (corepack install || corepack prepare ${packageManager} --activate)`];

  const commands: Toolchain["commands"] = {};
  const raw = snap.read("package.json");
  if (raw) {
    try {
      const scripts = (JSON.parse(raw) as { scripts?: Record<string, string> }).scripts ?? {};
      const run = (name: string) => `${packageManager} run ${name}`;
      // Only surface scripts that exist. A command an agent cannot run is worse than
      // no command, because it wastes a step and returns a confusing error.
      if (scripts.test) commands.test = run("test");
      if (scripts.lint) commands.lint = run("lint");
      if (scripts.build) commands.build = run("build");
      if (scripts.typecheck) commands.typecheck = run("typecheck");
      else if (scripts["type-check"]) commands.typecheck = run("type-check");
    } catch {
      // A malformed package.json is the repo's problem; detection still yields an image.
    }
  }

  return {
    kind: "node",
    image: NODE_IMAGE,
    packageManager,
    setup: [...activate, install],
    commands,
  };
}

function detectPython(snap: RepoSnapshot): Toolchain {
  const has = (f: string) => snap.files.includes(f);
  const setup: string[] = [];
  let packageManager = "pip";

  if (has("uv.lock")) {
    packageManager = "uv";
    setup.push("uv sync --frozen");
  } else if (has("poetry.lock")) {
    packageManager = "poetry";
    setup.push("poetry install --no-interaction");
  } else if (has("requirements.txt")) {
    setup.push("pip install --no-cache-dir -r requirements.txt");
  } else if (has("pyproject.toml")) {
    setup.push("pip install --no-cache-dir .");
  }

  const commands: Toolchain["commands"] = { test: "pytest -q" };
  const pyproject = snap.read("pyproject.toml") ?? "";
  if (pyproject.includes("[tool.ruff")) commands.lint = "ruff check .";
  if (pyproject.includes("[tool.mypy")) commands.typecheck = "mypy .";

  return { kind: "python", image: PYTHON_IMAGE, packageManager, setup, commands };
}

function detectGo(): Toolchain {
  return {
    kind: "go",
    image: GO_IMAGE,
    packageManager: "go",
    setup: ["go mod download"],
    commands: { test: "go test ./...", build: "go build ./...", lint: "go vet ./..." },
  };
}

function detectRust(): Toolchain {
  return {
    kind: "rust",
    image: RUST_IMAGE,
    packageManager: "cargo",
    setup: ["cargo fetch"],
    commands: { test: "cargo test", build: "cargo build", lint: "cargo clippy -- -D warnings" },
  };
}

/** Expands `setup: [auto]` and `allowedCommands: [auto]` against a detected toolchain. */
export function expandAuto(values: string[], resolved: string[]): string[] {
  return values.flatMap((v) => (v === "auto" ? resolved : [v]));
}

export function detectedCommands(tc: Toolchain): string[] {
  return Object.values(tc.commands).filter((c): c is string => Boolean(c));
}
