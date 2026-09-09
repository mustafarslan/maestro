import { describe, expect, it } from "vitest";
import { runConformance } from "./conformance.js";
import { Provider } from "./provider.js";
import { ProviderRegistry } from "./registry.js";
import { anthropicTransport, failingTransport, fakeConfig } from "./testing.js";
import { ProviderError } from "./types.js";

describe("Provider", () => {
  it("normalises usage so cached tokens are not also billed as input", async () => {
    // The SDK reports inputTokens as the TOTAL including cache; billing needs them
    // disjoint or cached tokens get charged twice.
    const t = anthropicTransport([
      { text: "hi", usage: { input: 100, output: 20, cacheRead: 800, cacheWrite: 100 } },
    ]);
    const res = await new Provider(fakeConfig(t)).chat({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
    });
  });

  it("maps a rate limit to a retryable ProviderError", async () => {
    const provider = new Provider(fakeConfig(failingTransport(429)));
    await expect(
      provider.chat({ model: "claude-opus-5", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ name: "ProviderError", opts: { retryable: true, status: 429 } });
  });

  it("maps a bad request to a non-retryable ProviderError", async () => {
    const provider = new Provider(fakeConfig(failingTransport(400)));
    await expect(
      provider.chat({ model: "claude-opus-5", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ name: "ProviderError", opts: { retryable: false, status: 400 } });
  });

  it("sends tool definitions on the wire", async () => {
    const t = anthropicTransport([{ text: "ok" }]);
    await new Provider(fakeConfig(t)).chat({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
    });

    const body = t.requests[0]?.body as { tools?: { name: string }[] };
    expect(body.tools?.map((x) => x.name)).toEqual(["read_file"]);
  });

  it("lists models from the provider's own endpoint", async () => {
    const models = await new Provider(fakeConfig(anthropicTransport([]))).listModels();
    expect(models.map((m) => m.id)).toContain("claude-opus-5");
    expect(models[0]?.capabilities.tools).toBe(true);
  });

  it("requires a baseUrl for an openai-compatible instance", () => {
    expect(() => new Provider({ id: "vllm", kind: "openai-compatible" })).toThrow(
      /requires a baseUrl/,
    );
  });
});

describe("ProviderRegistry", () => {
  const binding = {
    providerId: "anthropic",
    model: "claude-opus-5",
    maxSteps: 10,
    costCapCents: 100,
    fallback: [{ providerId: "ollama-local", model: "qwen3:8b" }],
  };

  it("resolves the primary when it is configured", () => {
    const reg = new ProviderRegistry([fakeConfig(anthropicTransport([]), { id: "anthropic" })]);
    const resolved = reg.resolve(binding);
    expect(resolved.provider.id).toBe("anthropic");
    expect(resolved.usedFallback).toBe(false);
  });

  it("falls back to a declared alternative when the primary is absent", () => {
    // The realistic case: a user configured only Ollama but imported a playbook
    // whose agents are bound to Anthropic.
    const reg = new ProviderRegistry([
      fakeConfig(anthropicTransport([]), {
        id: "ollama-local",
        kind: "openai-compatible",
        baseUrl: "http://localhost:11434/v1",
      }),
    ]);
    const resolved = reg.resolve(binding);
    expect(resolved.provider.id).toBe("ollama-local");
    expect(resolved.model).toBe("qwen3:8b");
    expect(resolved.usedFallback).toBe(true);
  });

  it("fails with an actionable message when nothing resolves", () => {
    const reg = new ProviderRegistry([]);
    expect(() => reg.resolve(binding)).toThrow(ProviderError);
    expect(() => reg.resolve(binding)).toThrow(/no configured provider.*Configured: none/s);
  });
});

describe("conformance suite", () => {
  it("passes a provider that behaves correctly", async () => {
    const t = anthropicTransport([
      { text: "Paris" },
      { toolCalls: [{ id: "1", name: "echo", input: { value: "maestro" } }] },
      { toolCalls: [{ id: "2", name: "echo", input: { value: "ping" } }] },
      { toolCalls: [{ id: "3", name: "submit", input: { answer: "ping" } }] },
      { text: "ok" },
      { text: "unused" },
    ]);
    const report = await runConformance(new Provider(fakeConfig(t)), "claude-opus-5");

    // Every check must pass except error mapping, which needs a real rejection the
    // scripted transport does not produce.
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c.passed]));
    expect(byName["plain completion"]).toBe(true);
    expect(byName["tool call"]).toBe(true);
    expect(byName["multi-turn tool loop with terminal tool"]).toBe(true);
    expect(byName["usage accounting"]).toBe(true);
    expect(report.observed.tools).toBe(true);
  });

  it("records tool support as false instead of failing, for local models", async () => {
    // Ollama tool support is per-model. A model that ignores tools should be recorded
    // honestly and still be usable for text-only work.
    const t = anthropicTransport([
      { text: "Paris" },
      { text: "I cannot use tools" },
      { text: "ok" },
    ]);
    const report = await runConformance(new Provider(fakeConfig(t)), "qwen3:8b");

    expect(report.observed.tools).toBe(false);
    expect(report.checks.find((c) => c.name === "tool call")?.passed).toBe(false);
  });
});

describe("extended thinking", () => {
  /** Captures the request body the adapter actually puts on the wire. */
  function capturing() {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "m",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    return { get: () => body, fetchImpl };
  }

  it("sends adaptive thinking to a model that rejects an explicit budget", async () => {
    // budget_tokens is rejected with a 400 on Opus 5 — which the shipped default playbook
    // binds three agents to. Sending the older shape would have failed every call the
    // moment anyone set the field in the Studio.
    const cap = capturing();
    const provider = new Provider({
      id: "anthropic",
      kind: "anthropic",
      apiKey: "sk-test",
      fetch: cap.fetchImpl,
    });
    await provider.chat({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hi" }],
      thinkingBudget: 4096,
    });

    expect(cap.get()?.thinking).toEqual({ type: "adaptive" });
    expect(JSON.stringify(cap.get())).not.toContain("budget_tokens");
  });

  it("sends Google a thinking budget, which is the same unit", async () => {
    // Previously left undefined alongside OpenAI, so a Google-bound agent silently ignored
    // the field: the Studio offered it, the schema carried it, nothing happened. Google's
    // `thinkingConfig.thinkingBudget` is a token count — Maestro's field exactly — so
    // there was nothing to guess at. Asserted on the wire, not on the options object.
    let body: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: "ok" }], role: "model" }, finishReason: "STOP" },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const provider = new Provider({
      id: "google",
      kind: "google",
      apiKey: "k",
      fetch: fetchImpl,
    });
    await provider.chat({
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hi" }],
      thinkingBudget: 2048,
    });

    expect((body?.generationConfig as { thinkingConfig?: unknown })?.thinkingConfig).toMatchObject({
      thinkingBudget: 2048,
    });
  });

  it("still sends an explicit budget to a model that requires one", async () => {
    const cap = capturing();
    const provider = new Provider({
      id: "anthropic",
      kind: "anthropic",
      apiKey: "sk-test",
      fetch: cap.fetchImpl,
    });
    await provider.chat({
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "hi" }],
      thinkingBudget: 4096,
    });

    expect(cap.get()?.thinking).toMatchObject({ type: "enabled", budget_tokens: 4096 });
  });

  it("sends nothing at all when no budget is configured", async () => {
    // The overwhelming majority of calls; a stray thinking block would change behaviour
    // and cost for every one of them.
    const cap = capturing();
    const provider = new Provider({
      id: "anthropic",
      kind: "anthropic",
      apiKey: "sk-test",
      fetch: cap.fetchImpl,
    });
    await provider.chat({ model: "claude-opus-5", messages: [{ role: "user", content: "hi" }] });
    expect(cap.get()?.thinking).toBeUndefined();
  });
});
