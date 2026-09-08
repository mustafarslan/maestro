import { openStore, type SqlDatabase } from "@maestro/core";
import { beforeEach, describe, expect, it } from "vitest";
import { ModelCatalog, ProviderConfigStore } from "./config-store.js";

let db: SqlDatabase;
let store: ProviderConfigStore;

beforeEach(async () => {
  db = await openStore({ path: ":memory:" });
  store = new ProviderConfigStore(db);
  // Keychain lookups would leak into the developer's real keychain during tests.
  process.env.MAESTRO_SECRETS = "file";
});

describe("ProviderConfigStore", () => {
  it("seeds the four default provider instances once", () => {
    store.ensureDefaults();
    store.ensureDefaults();
    expect(
      store
        .list()
        .map((p) => p.id)
        .sort(),
    ).toEqual(["anthropic", "google", "ollama", "openai"]);
  });

  it("registers an extra openai-compatible instance", () => {
    // "and so on": vLLM, LM Studio and OpenRouter cost one config row each.
    store.upsert({
      id: "vllm-gpu0",
      kind: "openai-compatible",
      baseUrl: "http://gpu0:8000/v1",
      enabled: true,
    });
    expect(store.list().find((p) => p.id === "vllm-gpu0")?.baseUrl).toBe("http://gpu0:8000/v1");
  });

  it("skips providers with no resolvable credential when building a registry", async () => {
    store.ensureDefaults();
    delete process.env.ANTHROPIC_API_KEY;
    const registry = await store.buildRegistry();

    // Local inference needs no key, so it is available; hosted ones without keys are not.
    expect(registry.has("ollama")).toBe(true);
    expect(registry.has("anthropic")).toBe(false);
  });

  it("includes a hosted provider once its key is in the environment", async () => {
    store.ensureDefaults();
    process.env.ANTHROPIC_API_KEY = "sk-test-123";
    try {
      expect((await store.buildRegistry()).has("anthropic")).toBe(true);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("never persists key material", () => {
    store.upsert({ id: "anthropic", kind: "anthropic", enabled: true });
    const row = db
      .prepare("SELECT * FROM provider_configs WHERE id=?")
      .get<Record<string, unknown>>("anthropic");
    expect(JSON.stringify(row)).not.toContain("sk-");
  });
});

describe("ModelCatalog", () => {
  it("replaces a provider's cached list on each refresh", () => {
    const catalog = new ModelCatalog(db);
    store.upsert({ id: "anthropic", kind: "anthropic", enabled: true });

    catalog.save("anthropic", "anthropic", [
      {
        id: "claude-opus-5",
        capabilities: {
          tools: true,
          jsonSchema: true,
          thinking: true,
          vision: true,
          caching: true,
        },
      },
      {
        id: "old-model",
        capabilities: {
          tools: true,
          jsonSchema: true,
          thinking: false,
          vision: false,
          caching: true,
        },
      },
    ]);
    catalog.save("anthropic", "anthropic", [
      {
        id: "claude-opus-5",
        capabilities: {
          tools: true,
          jsonSchema: true,
          thinking: true,
          vision: true,
          caching: true,
        },
      },
    ]);

    expect(catalog.list("anthropic").map((m) => m.id)).toEqual(["claude-opus-5"]);
  });
});
