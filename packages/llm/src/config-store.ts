import { logger, type SqlDatabase } from "@maestro/core";
import { resolveApiKey } from "./keys.js";
import { staticCapabilities } from "./pricing.js";
import type { ProviderConfig } from "./provider.js";
import { ProviderRegistry } from "./registry.js";
import type { ModelInfo, ProviderKind } from "./types.js";

interface ProviderRow {
  id: string;
  kind: string;
  base_url: string | null;
  key_ref: string | null;
  enabled: number;
  settings_json: string | null;
}

export interface StoredProvider {
  id: string;
  kind: ProviderKind;
  baseUrl?: string;
  enabled: boolean;
}

/**
 * Provider configuration lives in the store; key MATERIAL never does — only a reference
 * to the keychain (or env), resolved at registry build time.
 */
export class ProviderConfigStore {
  constructor(private readonly db: SqlDatabase) {}

  upsert(p: StoredProvider): void {
    this.db
      .prepare(
        `INSERT INTO provider_configs (id, kind, base_url, key_ref, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, base_url=excluded.base_url,
                                       enabled=excluded.enabled`,
      )
      .run(p.id, p.kind, p.baseUrl ?? null, p.id, p.enabled ? 1 : 0, new Date().toISOString());
  }

  list(): StoredProvider[] {
    return this.db
      .prepare("SELECT * FROM provider_configs ORDER BY id")
      .all<ProviderRow>()
      .map((r) => ({
        id: r.id,
        kind: r.kind as ProviderKind,
        baseUrl: r.base_url ?? undefined,
        enabled: r.enabled === 1,
      }));
  }

  remove(id: string): void {
    this.db.prepare("DELETE FROM provider_configs WHERE id=?").run(id);
  }

  /** Seeds the obvious defaults so a fresh install has something to talk to. */
  ensureDefaults(): void {
    if (this.list().length > 0) return;
    this.upsert({ id: "anthropic", kind: "anthropic", enabled: true });
    this.upsert({ id: "openai", kind: "openai", enabled: true });
    this.upsert({ id: "google", kind: "google", enabled: true });
    this.upsert({
      id: "ollama",
      kind: "openai-compatible",
      baseUrl: process.env.OLLAMA_HOST
        ? `${process.env.OLLAMA_HOST.replace(/\/$/, "")}/v1`
        : "http://localhost:11434/v1",
      enabled: true,
    });
  }

  /**
   * Builds a live registry, skipping providers with no resolvable credential. A provider
   * without a key is not an error — it simply is not available, and bindings fall back.
   */
  async buildRegistry(over: Partial<ProviderConfig> = {}): Promise<ProviderRegistry> {
    const registry = new ProviderRegistry();
    for (const p of this.list()) {
      if (!p.enabled) continue;
      const apiKey = await resolveApiKey(p.id, p.kind);
      // Local inference needs no key; hosted providers without one are skipped.
      if (!apiKey && p.kind !== "openai-compatible") {
        logger.debug({ providerId: p.id }, "provider skipped: no credential");
        continue;
      }
      registry.register({ id: p.id, kind: p.kind, baseUrl: p.baseUrl, apiKey, ...over });
    }
    return registry;
  }
}

export interface CatalogEntry extends ModelInfo {
  providerId: string;
  fetchedAt: string;
}

/** Caches each provider's live model list so the UI picker is a dropdown, not a text field. */
export class ModelCatalog {
  constructor(private readonly db: SqlDatabase) {}

  save(providerId: string, kind: string, models: ModelInfo[]): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM model_catalog WHERE provider_id=?").run(providerId);
      const stmt = this.db.prepare(
        `INSERT INTO model_catalog (provider_id, model, display_name, capabilities_json,
                                    input_cost_per_mtok, output_cost_per_mtok, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const m of models) {
        stmt.run(
          providerId,
          m.id,
          m.displayName ?? null,
          JSON.stringify(m.capabilities ?? staticCapabilities(kind, m.id)),
          m.inputCostPerMTok ?? null,
          m.outputCostPerMTok ?? null,
          now,
        );
      }
    });
  }

  list(providerId?: string): CatalogEntry[] {
    const rows = providerId
      ? this.db
          .prepare("SELECT * FROM model_catalog WHERE provider_id=? ORDER BY model")
          .all<Record<string, string>>(providerId)
      : this.db
          .prepare("SELECT * FROM model_catalog ORDER BY provider_id, model")
          .all<Record<string, string>>();

    return rows.map((r) => ({
      providerId: r.provider_id as string,
      id: r.model as string,
      displayName: (r.display_name as string) ?? undefined,
      capabilities: JSON.parse(r.capabilities_json as string),
      fetchedAt: r.fetched_at as string,
    }));
  }
}
