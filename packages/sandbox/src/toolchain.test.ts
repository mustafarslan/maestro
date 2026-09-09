import { describe, expect, it } from "vitest";
import { detectedCommands, detectToolchain, expandAuto, type RepoSnapshot } from "./toolchain.js";

const snap = (files: string[], contents: Record<string, string> = {}): RepoSnapshot => ({
  files,
  read: (p) => contents[p],
});

describe("toolchain detection", () => {
  it("activates a non-npm package manager before using it", () => {
    // The Node images ship corepack but not the packaged manager itself, so every
    // `pnpm run ...` command an agent was told it could run exited 127.
    const pnpm = detectToolchain(snap(["package.json", "pnpm-lock.yaml"]));
    expect(pnpm.setup[0]).toContain("corepack");
    expect(pnpm.setup[0]).toContain("pnpm");

    // npm needs no activation, so it gets no extra step.
    expect(detectToolchain(snap(["package.json", "package-lock.json"])).setup).toHaveLength(1);
  });

  it("picks the package manager from the lockfile, not from package.json", () => {
    // Running `npm ci` in a pnpm repo either fails or silently builds a different tree.
    expect(detectToolchain(snap(["package.json", "pnpm-lock.yaml"])).packageManager).toBe("pnpm");
    expect(detectToolchain(snap(["package.json", "yarn.lock"])).packageManager).toBe("yarn");
    expect(detectToolchain(snap(["package.json", "package-lock.json"])).packageManager).toBe("npm");
    expect(detectToolchain(snap(["package.json", "bun.lockb"])).packageManager).toBe("bun");
  });

  it("skips lifecycle scripts, which are arbitrary code from the dependency tree", () => {
    // Also the main cause of install failure behind an egress allowlist: postinstall
    // hooks fetch binaries from CDNs that are not on the registry allowlist.
    for (const lock of ["package-lock.json", "pnpm-lock.yaml", "bun.lockb"]) {
      const setup = detectToolchain(snap(["package.json", lock])).setup.join(" ");
      expect(setup, lock).toMatch(/--ignore-scripts/);
    }
    expect(detectToolchain(snap(["package.json", "yarn.lock"])).setup.join(" ")).toContain(
      "--mode=skip-build",
    );
  });

  it("uses a frozen-lockfile install so a review cannot silently drift", () => {
    expect(detectToolchain(snap(["package.json", "package-lock.json"])).setup).toEqual([
      "npm ci --ignore-scripts",
    ]);
    // pnpm/yarn setups are prefixed with a corepack activation, so assert on the whole
    // sequence rather than the first entry.
    expect(detectToolchain(snap(["package.json", "pnpm-lock.yaml"])).setup.join(" ")).toContain(
      "--frozen-lockfile",
    );
  });

  it("only surfaces scripts that actually exist", () => {
    // An allowlisted command that does not exist wastes an agent step on a confusing error.
    const tc = detectToolchain(
      snap(["package.json", "package-lock.json"], {
        "package.json": JSON.stringify({ scripts: { test: "vitest", lint: "eslint ." } }),
      }),
    );
    expect(tc.commands).toEqual({ test: "npm run test", lint: "npm run lint" });
    expect(tc.commands.build).toBeUndefined();
  });

  it("accepts either typecheck spelling", () => {
    const tc = detectToolchain(
      snap(["package.json"], {
        "package.json": JSON.stringify({ scripts: { "type-check": "tsc" } }),
      }),
    );
    expect(tc.commands.typecheck).toBe("npm run type-check");
  });

  it("survives a malformed package.json", () => {
    const tc = detectToolchain(snap(["package.json"], { "package.json": "{not json" }));
    expect(tc.kind).toBe("node");
    expect(tc.commands).toEqual({});
  });

  it("detects python package managers in lockfile-first order", () => {
    expect(detectToolchain(snap(["pyproject.toml", "uv.lock"])).setup).toEqual([
      "uv sync --frozen",
    ]);
    expect(detectToolchain(snap(["pyproject.toml", "poetry.lock"])).packageManager).toBe("poetry");
    expect(detectToolchain(snap(["requirements.txt"])).setup[0]).toContain("requirements.txt");
  });

  it("reads python lint config out of pyproject", () => {
    const tc = detectToolchain(
      snap(["pyproject.toml"], {
        "pyproject.toml": "[tool.ruff]\nline-length = 100\n[tool.mypy]\n",
      }),
    );
    expect(tc.commands.lint).toBe("ruff check .");
    expect(tc.commands.typecheck).toBe("mypy .");
  });

  it("detects go and rust", () => {
    expect(detectToolchain(snap(["go.mod"])).commands.test).toBe("go test ./...");
    expect(detectToolchain(snap(["Cargo.toml"])).commands.test).toBe("cargo test");
  });

  it("falls back to a polyglot base rather than guessing", () => {
    const tc = detectToolchain(snap(["README.md"]));
    expect(tc.kind).toBe("unknown");
    expect(tc.setup).toEqual([]);
  });

  it("expands 'auto' in place and keeps explicit entries", () => {
    expect(expandAuto(["auto", "npm run e2e"], ["npm ci"])).toEqual(["npm ci", "npm run e2e"]);
    expect(expandAuto(["npm run only-this"], ["npm ci"])).toEqual(["npm run only-this"]);
  });

  it("derives the allowlist from the detected commands", () => {
    const tc = detectToolchain(
      snap(["package.json"], {
        "package.json": JSON.stringify({ scripts: { test: "v", lint: "e" } }),
      }),
    );
    expect(detectedCommands(tc).sort()).toEqual(["npm run lint", "npm run test"]);
  });
});
