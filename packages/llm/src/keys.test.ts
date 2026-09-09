import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveApiKey, secretStore } from "./keys.js";

let home: string;
const originalHome = process.env.MAESTRO_HOME;
const originalSecrets = process.env.MAESTRO_SECRETS;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "maestro-keys-"));
  process.env.MAESTRO_HOME = home;
  // Force the file backend: the keychain is the machine's, not the test's, and a test
  // that writes to a developer's real keychain is a test nobody should run twice.
  process.env.MAESTRO_SECRETS = "file";
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.MAESTRO_HOME;
  else process.env.MAESTRO_HOME = originalHome;
  if (originalSecrets === undefined) delete process.env.MAESTRO_SECRETS;
  else process.env.MAESTRO_SECRETS = originalSecrets;
});

const secretsFile = () => join(home, "secrets.json");

describe("the file secret store", () => {
  it("round-trips a secret", async () => {
    const store = await secretStore();
    await store.set("anthropic", "sk-ant-secret");
    expect(await store.get("anthropic")).toBe("sk-ant-secret");
  });

  it("keeps other providers' keys when one is written", async () => {
    // Every key lives in one JSON object, so a bad write does not damage one entry —
    // it destroys all of them. The write is atomic for exactly this reason.
    const store = await secretStore();
    await store.set("anthropic", "a");
    await store.set("openai", "b");
    await store.set("google", "c");

    expect(await store.get("anthropic")).toBe("a");
    expect(await store.get("openai")).toBe("b");
    expect(await store.get("google")).toBe("c");
  });

  it("leaves no temp file behind", async () => {
    // The atomic write uses a sibling temp file; leaving one would leak a secret into a
    // path nothing later chmods or cleans.
    const store = await secretStore();
    await store.set("anthropic", "a");
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(home).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("writes the file readable only by its owner", async () => {
    const store = await secretStore();
    await store.set("anthropic", "sk-ant-secret");
    // 0600: an API key readable by other local accounts is a credential leak.
    expect(statSync(secretsFile()).mode & 0o777).toBe(0o600);
  });

  it("survives a corrupt store instead of crashing every command", async () => {
    // A truncated or hand-edited file would otherwise throw a JSON parse error out of
    // whatever happened to resolve a key, naming neither the file nor the fix.
    writeFileSync(secretsFile(), '{"anthropic": "sk-ant', { mode: 0o600 });
    const store = await secretStore();
    await expect(store.get("anthropic")).resolves.toBeUndefined();

    // And it must still be writable afterwards, not permanently wedged.
    await store.set("anthropic", "recovered");
    expect(await store.get("anthropic")).toBe("recovered");
  });

  it("ignores a store whose JSON is valid but the wrong shape", async () => {
    writeFileSync(secretsFile(), "[1,2,3]", { mode: 0o600 });
    const store = await secretStore();
    await expect(store.get("anthropic")).resolves.toBeUndefined();
  });

  it("deleting a key leaves the others intact", async () => {
    const store = await secretStore();
    await store.set("anthropic", "a");
    await store.set("openai", "b");
    await store.delete("anthropic");

    expect(await store.get("anthropic")).toBeUndefined();
    expect(await store.get("openai")).toBe("b");
  });

  it("deleting from a store that does not exist is not an error", async () => {
    const store = await secretStore();
    await expect(store.delete("anthropic")).resolves.toBeUndefined();
  });

  it("repairs permissions on a store that was left world-readable", async () => {
    const store = await secretStore();
    await store.set("anthropic", "a");
    chmodSync(secretsFile(), 0o644);
    await store.set("openai", "b");
    expect(statSync(secretsFile()).mode & 0o777).toBe(0o600);
  });
});

describe("key resolution order", () => {
  const saved: Record<string, string | undefined> = {};
  const setEnv = (name: string, value?: string) => {
    if (!(name in saved)) saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("prefers the instance-specific variable over the conventional one", async () => {
    // Two instances of the same kind — say a local Ollama and a remote one — need
    // different keys, which the conventional variable alone cannot express.
    setEnv("MAESTRO_KEY_ANTHROPIC", "instance-key");
    setEnv("ANTHROPIC_API_KEY", "conventional-key");
    expect(await resolveApiKey("anthropic", "anthropic")).toBe("instance-key");
  });

  it("maps a hyphenated instance id onto its variable name", async () => {
    setEnv("MAESTRO_KEY_OLLAMA_GPU0", "gpu-key");
    expect(await resolveApiKey("ollama-gpu0", "openai-compatible")).toBe("gpu-key");
  });

  it("falls back to the conventional variable for the kind", async () => {
    setEnv("MAESTRO_KEY_ANTHROPIC", undefined);
    setEnv("ANTHROPIC_API_KEY", "conventional-key");
    expect(await resolveApiKey("anthropic", "anthropic")).toBe("conventional-key");
  });

  it("accepts either of Google's two conventional names", async () => {
    setEnv("MAESTRO_KEY_GOOGLE", undefined);
    setEnv("GOOGLE_GENERATIVE_AI_API_KEY", undefined);
    setEnv("GEMINI_API_KEY", "gemini-key");
    expect(await resolveApiKey("google", "google")).toBe("gemini-key");
  });

  it("falls through to the store when no variable is set", async () => {
    setEnv("MAESTRO_KEY_ANTHROPIC", undefined);
    setEnv("ANTHROPIC_API_KEY", undefined);
    (await secretStore()).set("anthropic", "stored-key");
    expect(await resolveApiKey("anthropic", "anthropic")).toBe("stored-key");
  });

  it("returns nothing for an openai-compatible instance with no key, which is normal", async () => {
    // A local Ollama needs no credential at all; this must not be an error.
    setEnv("MAESTRO_KEY_OLLAMA", undefined);
    expect(await resolveApiKey("ollama", "openai-compatible")).toBeUndefined();
  });
});
