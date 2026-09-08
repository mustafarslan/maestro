import { logger } from "@maestro/core";
import { Provider, type ProviderConfig } from "./provider.js";
import { ProviderError } from "./types.js";

export interface ModelBindingLike {
  providerId: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  maxSteps: number;
  costCapCents: number;
  fallback: { providerId: string; model: string }[];
}

export interface ResolvedBinding {
  provider: Provider;
  model: string;
  /** True when the primary was unavailable and a declared fallback was used instead. */
  usedFallback: boolean;
}

/**
 * Holds configured provider instances and resolves a playbook's agent binding to a live
 * provider, walking the declared fallback chain when the primary is not configured.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();

  constructor(configs: ProviderConfig[] = []) {
    for (const c of configs) this.register(c);
  }

  register(config: ProviderConfig): Provider {
    const provider = new Provider(config);
    this.providers.set(config.id, provider);
    return provider;
  }

  get(id: string): Provider | undefined {
    return this.providers.get(id);
  }

  ids(): string[] {
    return [...this.providers.keys()];
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  /**
   * Resolution is static — it only skips providers that are not configured. Runtime
   * failover on a live error is the loop's business, not the registry's.
   */
  resolve(binding: ModelBindingLike): ResolvedBinding {
    const primary = this.providers.get(binding.providerId);
    if (primary) return { provider: primary, model: binding.model, usedFallback: false };

    for (const alt of binding.fallback) {
      const provider = this.providers.get(alt.providerId);
      if (provider) {
        logger.warn(
          { requested: binding.providerId, using: alt.providerId, model: alt.model },
          "primary provider not configured, using declared fallback",
        );
        return { provider, model: alt.model, usedFallback: true };
      }
    }

    throw new ProviderError(
      `no configured provider for '${binding.providerId}'` +
        (binding.fallback.length
          ? ` or its fallbacks (${binding.fallback.map((f) => f.providerId).join(", ")})`
          : "") +
        `. Configured: ${this.ids().join(", ") || "none"}`,
      { providerId: binding.providerId, retryable: false },
    );
  }
}
