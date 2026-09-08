import { describe, expect, it } from "vitest";
import { costCents, PRICING, resolvePricing, staticCapabilities } from "./pricing.js";
import type { Usage } from "./types.js";

const usage = (over: Partial<Usage> = {}): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...over,
});

describe("pricing", () => {
  it("prices a plain call from the published rates", () => {
    // Opus 5: $5/MTok in, $25/MTok out. 1M in + 1M out = $30 = 3000 cents.
    const cost = costCents(
      "anthropic",
      "claude-opus-5",
      usage({ inputTokens: 1e6, outputTokens: 1e6 }),
    );
    expect(cost).toBeCloseTo(3000, 6);
  });

  it("prefers the longest matching prefix", () => {
    // "claude-opus-4-8" must not be resolved by a shorter "claude-opus-4" style entry,
    // and Sonnet 4.6 ($3) must not inherit Sonnet 5's ($2) rate.
    expect(resolvePricing("anthropic", "claude-sonnet-5").inputPerMTok).toBe(2);
    expect(resolvePricing("anthropic", "claude-sonnet-4-6").inputPerMTok).toBe(3);
    expect(resolvePricing("anthropic", "claude-opus-4-8").inputPerMTok).toBe(5);
  });

  it("bills cache reads at a tenth and cache writes at 1.25x", () => {
    const p = resolvePricing("anthropic", "claude-opus-5");
    expect(p.cacheReadPerMTok).toBeCloseTo(0.5, 10);
    expect(p.cacheWritePerMTok).toBeCloseTo(6.25, 10);

    const cost = costCents("anthropic", "claude-opus-5", usage({ cacheReadTokens: 1e6 }));
    expect(cost).toBeCloseTo(50, 6); // $0.50
  });

  it("uses an explicit cache-read rate when a model publishes one", () => {
    // Fable 5.1 prices cache reads directly at $0.25/MTok rather than 0.1x input.
    expect(resolvePricing("anthropic", "claude-fable-5-1").cacheReadPerMTok).toBe(0.25);
  });

  it("does not double-charge cached tokens", () => {
    // Cached and uncached input are disjoint, so a mostly-cached call must be far
    // cheaper than the same token count billed entirely at the input rate.
    const cached = costCents(
      "anthropic",
      "claude-opus-5",
      usage({ inputTokens: 1e5, cacheReadTokens: 9e5 }),
    );
    const uncached = costCents("anthropic", "claude-opus-5", usage({ inputTokens: 1e6 }));
    expect(cached).toBeLessThan(uncached / 2);
  });

  it("reports zero for an unknown model rather than inventing a price", () => {
    // Silently guessing a rate would put a fabricated number in the PR comment.
    expect(resolvePricing("anthropic", "some-future-model").known).toBe(false);
    expect(costCents("anthropic", "some-future-model", usage({ inputTokens: 1e6 }))).toBe(0);
    expect(costCents("openai-compatible", "qwen3:8b", usage({ inputTokens: 1e9 }))).toBe(0);
  });

  it("keeps every published model id free of a date suffix", () => {
    // Date-suffixed ids are rejected by the API; this guards against reintroducing one.
    for (const entry of PRICING.anthropic ?? []) {
      expect(entry.prefix, entry.prefix).not.toMatch(/-\d{8}$/);
    }
  });
});

describe("capabilities", () => {
  it("reports tool and cache support for known Anthropic models", () => {
    const caps = staticCapabilities("anthropic", "claude-opus-5");
    expect(caps).toMatchObject({ tools: true, jsonSchema: true, caching: true });
    expect(caps.contextWindow).toBe(1_000_000);
  });

  it("does not assume tool support for an unknown local model", () => {
    // Ollama tool support is per-model; the conformance run decides, not optimism.
    expect(staticCapabilities("openai-compatible", "qwen3:8b").tools).toBe(false);
  });

  it("assumes tools for an unknown hosted model", () => {
    expect(staticCapabilities("openai", "gpt-6-turbo").tools).toBe(true);
  });
});
