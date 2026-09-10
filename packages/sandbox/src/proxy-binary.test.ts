import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProxyBinary } from "./proxy-binary.js";

/**
 * Finding a Linux build of Maestro for the egress proxy container.
 *
 * The download half is pinned here because of how it failed in practice: it fetched the
 * plain release download URL, which answers **404** for a private repository even with a
 * valid token — indistinguishable from "that version was never released". `install.sh`
 * already knew this and says so in a comment; this code was written without it, and the
 * bug only appeared when a real release was published and really fetched.
 */

let home: string;
const saved = { ...process.env };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "maestro-pb-"));
  process.env.MAESTRO_HOME = home;
  for (const v of [
    "MAESTRO_PROXY_BINARY",
    "MAESTRO_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "MAESTRO_BASE_URL",
  ]) {
    delete process.env[v];
  }
  // The local-build branch would win otherwise, and this file is about the download.
  vi.spyOn(process, "cwd").mockReturnValue(home);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  process.env = { ...saved };
});

/** A minimal ELF header; the resolver rejects anything that is not one. */
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64, 1)]);

describe("downloading the proxy binary", () => {
  it("asks the API for the asset id rather than the browser download URL", async () => {
    // The browser URL is what a private release refuses. Asserting the API is used is
    // the whole point: a test that only checked "a binary arrived" would pass against
    // the version that 404s for every private repository.
    process.env.MAESTRO_TOKEN = "tok";
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push(String(url));
      if (String(url).includes("/releases/tags/")) {
        expect(init?.headers?.Authorization).toBe("Bearer tok");
        return {
          ok: true,
          json: async () => ({
            assets: [
              { name: "maestro-linux-x64", url: "https://api.github.com/…/assets/1" },
              { name: "maestro-linux-arm64", url: "https://api.github.com/…/assets/2" },
            ],
          }),
        };
      }
      expect(init?.headers?.Accept).toBe("application/octet-stream");
      return { ok: true, arrayBuffer: async () => ELF };
    });

    const got = await resolveProxyBinary({ version: "9.9.9" });
    expect(got.source).toBe("download");
    expect(calls[0]).toContain("api.github.com");
    expect(calls[0]).toContain("/releases/tags/v9.9.9");
    // By asset id, not by name in a download path.
    expect(calls[1]).toBe("https://api.github.com/…/assets/2");
    expect(calls.some((c) => c.includes("/releases/download/"))).toBe(false);
  });

  it("caches under the version, so an older binary is never reused for a newer one", async () => {
    // The proxy runs a subcommand that did not exist in every past release; a cache keyed
    // only by architecture would serve one of those for ever.
    process.env.MAESTRO_TOKEN = "tok";
    vi.stubGlobal("fetch", async (url: string) =>
      String(url).includes("/releases/tags/")
        ? { ok: true, json: async () => ({ assets: [{ name: "maestro-linux-arm64", url: "a" }] }) }
        : { ok: true, arrayBuffer: async () => ELF },
    );
    const got = await resolveProxyBinary({ version: "9.9.9" });
    expect(got.path).toContain("-9.9.9");
    expect(readFileSync(got.path)).toEqual(ELF);
  });

  it("refuses an HTML error page served with status 200", async () => {
    // A mirror or proxy answering with a login page sails past an `ok` check, and the
    // only later symptom is `exec format error` inside a container nobody is watching.
    process.env.MAESTRO_TOKEN = "tok";
    vi.stubGlobal("fetch", async (url: string) =>
      String(url).includes("/releases/tags/")
        ? { ok: true, json: async () => ({ assets: [{ name: "maestro-linux-arm64", url: "a" }] }) }
        : { ok: true, arrayBuffer: async () => Buffer.from("<!doctype html><title>Sign in") },
    );
    await expect(resolveProxyBinary({ version: "9.9.9" })).rejects.toThrow(
      /could not find or fetch/,
    );
  });

  it("names the private-repository case when it cannot fetch anything", async () => {
    // A 404 on a private release reads as "that version does not exist", which sends
    // somebody to check the version number rather than their credentials.
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 404 }));
    await expect(resolveProxyBinary({ version: "9.9.9" })).rejects.toThrow(/MAESTRO_TOKEN/);
  });

  it("prefers an explicit MAESTRO_PROXY_BINARY over anything it could fetch", async () => {
    const explicit = join(home, "maestro-linux");
    writeFileSync(explicit, ELF);
    process.env.MAESTRO_PROXY_BINARY = explicit;
    vi.stubGlobal("fetch", async () => {
      throw new Error("must not be called");
    });
    const got = await resolveProxyBinary({ version: "9.9.9" });
    expect(got.source).toBe("env");
    expect(got.path).toBe(explicit);
  });
});
