import type { ModelCapabilities, Usage } from "./types.js";

/**
 * Model pricing and capability data.
 *
 * This is DATA, deliberately kept in one file with provenance, because these numbers
 * flow straight into the metrics block of a PR comment. A wrong constant here is a
 * silent correctness bug that nobody notices until they reconcile a bill.
 *
 * Anthropic figures: bundled claude-api skill reference, cached 2026-06-24.
 * Other providers: public pricing pages; see `source` per entry.
 * Update procedure: change the number AND the `fetchedAt` stamp.
 */

export interface PricingEntry {
  /** Matched as a prefix against the model id, longest match wins. */
  prefix: string;
  inputPerMTok: number;
  outputPerMTok: number;
  /** Absolute rate when a provider prices cache reads directly, else the multiplier below. */
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
  capabilities: ModelCapabilities;
  displayName?: string;
}

/** Anthropic cache economics: writes cost ~1.25x input, reads ~0.1x input. */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

const full = (over: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  tools: true,
  jsonSchema: true,
  thinking: true,
  vision: true,
  caching: true,
  ...over,
});

export const PRICING_FETCHED_AT = "2026-06-24";

export const PRICING: Record<string, PricingEntry[]> = {
  // source: bundled claude-api skill model table, cached 2026-06-24
  anthropic: [
    {
      prefix: "claude-fable-5-1",
      inputPerMTok: 10,
      outputPerMTok: 50,
      cacheReadPerMTok: 0.25,
      displayName: "Claude Fable 5.1",
      capabilities: full({ contextWindow: 1_000_000 }),
    },
    {
      prefix: "claude-fable-5",
      inputPerMTok: 10,
      outputPerMTok: 50,
      displayName: "Claude Fable 5",
      capabilities: full({ contextWindow: 1_000_000 }),
    },
    {
      prefix: "claude-opus-5",
      inputPerMTok: 5,
      outputPerMTok: 25,
      displayName: "Claude Opus 5",
      capabilities: full({ contextWindow: 1_000_000 }),
    },
    {
      prefix: "claude-opus-4-8",
      inputPerMTok: 5,
      outputPerMTok: 25,
      displayName: "Claude Opus 4.8",
      capabilities: full({ contextWindow: 1_000_000 }),
    },
    {
      prefix: "claude-opus-4-7",
      inputPerMTok: 5,
      outputPerMTok: 25,
      displayName: "Claude Opus 4.7",
      capabilities: full({ contextWindow: 1_000_000 }),
    },
    {
      prefix: "claude-opus-4-6",
      inputPerMTok: 5,
      outputPerMTok: 25,
      displayName: "Claude Opus 4.6",
      capabilities: full({ contextWindow: 1_000_000 }),
    },
    {
      prefix: "claude-sonnet-5",
      inputPerMTok: 2,
      outputPerMTok: 10,
      displayName: "Claude Sonnet 5",
      capabilities: full({ contextWindow: 1_000_000 }),
    },
    {
      prefix: "claude-sonnet-4-6",
      inputPerMTok: 3,
      outputPerMTok: 15,
      displayName: "Claude Sonnet 4.6",
      capabilities: full({ contextWindow: 1_000_000 }),
    },
    {
      prefix: "claude-haiku-4-5",
      inputPerMTok: 1,
      outputPerMTok: 5,
      displayName: "Claude Haiku 4.5",
      capabilities: full({ contextWindow: 200_000 }),
    },
  ],
  // source: https://openai.com/api/pricing (verify before trusting the metrics block)
  openai: [
    {
      prefix: "gpt-5",
      inputPerMTok: 1.25,
      outputPerMTok: 10,
      cacheReadPerMTok: 0.125,
      displayName: "GPT-5",
      capabilities: full({ contextWindow: 400_000 }),
    },
    {
      prefix: "gpt-4.1-mini",
      inputPerMTok: 0.4,
      outputPerMTok: 1.6,
      cacheReadPerMTok: 0.1,
      capabilities: full({ thinking: false, contextWindow: 1_000_000 }),
    },
    {
      prefix: "gpt-4.1",
      inputPerMTok: 2,
      outputPerMTok: 8,
      cacheReadPerMTok: 0.5,
      capabilities: full({ thinking: false, contextWindow: 1_000_000 }),
    },
    {
      prefix: "o4-mini",
      inputPerMTok: 1.1,
      outputPerMTok: 4.4,
      cacheReadPerMTok: 0.275,
      capabilities: full({ contextWindow: 200_000 }),
    },
  ],
  // source: https://ai.google.dev/pricing
  google: [
    {
      prefix: "gemini-2.5-pro",
      inputPerMTok: 1.25,
      outputPerMTok: 10,
      capabilities: full({ contextWindow: 1_048_576 }),
    },
    {
      prefix: "gemini-2.5-flash",
      inputPerMTok: 0.3,
      outputPerMTok: 2.5,
      capabilities: full({ contextWindow: 1_048_576 }),
    },
    {
      prefix: "gemini-2.0-flash",
      inputPerMTok: 0.1,
      outputPerMTok: 0.4,
      capabilities: full({ thinking: false, contextWindow: 1_048_576 }),
    },
  ],
  // Local inference: no marginal token cost. Tool support is per-model and is
  // discovered by the conformance run rather than assumed.
  "openai-compatible": [],
};

export interface ResolvedPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
  known: boolean;
}

export function resolvePricing(kind: string, model: string): ResolvedPricing {
  const entries = PRICING[kind] ?? [];
  // Longest prefix wins so "claude-opus-4-8" is not swallowed by "claude-opus-4".
  const match = entries
    .filter((e) => model.startsWith(e.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];

  if (!match) {
    return {
      inputPerMTok: 0,
      outputPerMTok: 0,
      cacheReadPerMTok: 0,
      cacheWritePerMTok: 0,
      known: false,
    };
  }
  return {
    inputPerMTok: match.inputPerMTok,
    outputPerMTok: match.outputPerMTok,
    cacheReadPerMTok: match.cacheReadPerMTok ?? match.inputPerMTok * CACHE_READ_MULTIPLIER,
    cacheWritePerMTok: match.cacheWritePerMTok ?? match.inputPerMTok * CACHE_WRITE_MULTIPLIER,
    known: true,
  };
}

/**
 * Cost in cents. Cache-read and cache-write tokens are billed at their own rates and
 * are NOT also counted as input tokens — the adapters report them disjointly.
 */
export function costCents(kind: string, model: string, usage: Usage): number {
  const p = resolvePricing(kind, model);
  if (!p.known) return 0;
  const dollars =
    (usage.inputTokens * p.inputPerMTok +
      usage.outputTokens * p.outputPerMTok +
      usage.cacheReadTokens * p.cacheReadPerMTok +
      usage.cacheWriteTokens * p.cacheWritePerMTok) /
    1_000_000;
  return dollars * 100;
}

/** Static capability lookup: no provider's list endpoint reports tool/schema support. */
export function staticCapabilities(kind: string, model: string): ModelCapabilities {
  const entries = PRICING[kind] ?? [];
  const match = entries
    .filter((e) => model.startsWith(e.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (match) return match.capabilities;

  // Unknown model: assume the common denominator and let a conformance run
  // downgrade the flags rather than optimistically claiming support.
  return {
    tools: kind !== "openai-compatible",
    jsonSchema: kind !== "openai-compatible",
    thinking: false,
    vision: false,
    caching: kind === "anthropic",
  };
}

export function knownModels(kind: string): string[] {
  return (PRICING[kind] ?? []).map((e) => e.prefix);
}
