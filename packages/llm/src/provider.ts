import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  APICallError,
  generateText,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  tool as makeTool,
} from "ai";
import { staticCapabilities } from "./pricing.js";
import {
  type ChatRequest,
  type ChatResponse,
  type FinishReason,
  type Message,
  type ModelCapabilities,
  type ModelInfo,
  ProviderError,
  type ProviderKind,
  type ToolCall,
  type Usage,
} from "./types.js";

export interface ProviderConfig {
  /** Instance id — "anthropic", "ollama-local", "vllm-gpu0". Providers are instances,
   *  not a fixed list of four, which is what makes "and so on" cheap to satisfy. */
  id: string;
  kind: ProviderKind;
  baseUrl?: string;
  apiKey?: string;
  /** Injectable so the conformance suite can replay recorded fixtures offline. */
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
}

/** The AI SDK is used for per-call normalisation ONLY. The agent loop, budgets and step
 *  limits are Maestro's — nothing here should reach for the SDK's own loop controls. */
export class Provider {
  readonly id: string;
  readonly kind: ProviderKind;
  private readonly makeModel: (modelId: string) => LanguageModel;

  constructor(private readonly config: ProviderConfig) {
    this.id = config.id;
    this.kind = config.kind;
    this.makeModel = buildFactory(config);
  }

  capabilities(model: string): ModelCapabilities {
    return staticCapabilities(this.kind, model);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    try {
      const result = await generateText({
        model: this.makeModel(req.model),
        system: req.system,
        messages: toModelMessages(req.messages),
        tools: req.tools?.length ? toToolSet(req.tools) : undefined,
        temperature: req.temperature,
        maxOutputTokens: req.maxTokens,
        abortSignal: req.signal,
        // Maestro's loop owns retries. Leaving the SDK's layer on as well would give
        // 3x3 attempts with compounding backoff, invisible to the budget check.
        maxRetries: 0,
      });

      return {
        text: result.text,
        toolCalls: result.toolCalls.map(
          (c): ToolCall => ({ id: c.toolCallId, name: c.toolName, input: c.input }),
        ),
        finishReason: normaliseFinish(result.finishReason),
        usage: normaliseUsage(result.usage),
        latencyMs: Date.now() - started,
        model: req.model,
        providerId: this.id,
      };
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  /** Every provider exposes a list endpoint; none of them report tool or schema support,
   *  which is why capabilities come from the static table instead. */
  async listModels(): Promise<ModelInfo[]> {
    const ids = await this.fetchModelIds();
    return ids.map((id) => ({ id, capabilities: this.capabilities(id) }));
  }

  private async fetchModelIds(): Promise<string[]> {
    const f = this.config.fetch ?? globalThis.fetch;
    const { url, headers, extract } = listEndpoint(this.config);
    const res = await f(url, { headers });
    if (!res.ok) {
      throw new ProviderError(`listModels failed: ${res.status} ${res.statusText}`, {
        providerId: this.id,
        status: res.status,
        retryable: res.status === 429 || res.status >= 500,
      });
    }
    return extract((await res.json()) as Record<string, unknown>);
  }

  private wrapError(err: unknown): ProviderError {
    if (err instanceof ProviderError) return err;
    if (APICallError.isInstance(err)) {
      const status = err.statusCode;
      return new ProviderError(err.message, {
        providerId: this.id,
        status,
        // Rate limits, server errors and transport failures are worth another attempt;
        // a 400 means the request itself is wrong and retrying just burns budget.
        retryable: err.isRetryable || status === 429 || (status !== undefined && status >= 500),
        cause: err,
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    const isAbort = err instanceof Error && err.name === "AbortError";
    return new ProviderError(message, { providerId: this.id, retryable: !isAbort, cause: err });
  }
}

function buildFactory(config: ProviderConfig): (modelId: string) => LanguageModel {
  const shared = {
    apiKey: config.apiKey,
    fetch: config.fetch,
    headers: config.headers,
  };
  switch (config.kind) {
    case "anthropic": {
      const p = createAnthropic({ ...shared, baseURL: config.baseUrl });
      return (m) => p(m);
    }
    case "openai": {
      const p = createOpenAI({ ...shared, baseURL: config.baseUrl });
      return (m) => p(m);
    }
    case "google": {
      const p = createGoogleGenerativeAI({ ...shared, baseURL: config.baseUrl });
      return (m) => p(m);
    }
    case "openai-compatible": {
      if (!config.baseUrl) {
        throw new Error(`provider '${config.id}': openai-compatible requires a baseUrl`);
      }
      const p = createOpenAICompatible({ ...shared, name: config.id, baseURL: config.baseUrl });
      return (m) => p(m);
    }
  }
}

interface ListEndpoint {
  url: string;
  headers: Record<string, string>;
  extract: (body: Record<string, unknown>) => string[];
}

function listEndpoint(config: ProviderConfig): ListEndpoint {
  const key = config.apiKey ?? "";
  switch (config.kind) {
    case "anthropic":
      return {
        url: `${config.baseUrl ?? "https://api.anthropic.com"}/v1/models?limit=100`,
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        extract: (b) => (b.data as { id: string }[] | undefined)?.map((m) => m.id) ?? [],
      };
    case "openai":
      return {
        url: `${config.baseUrl ?? "https://api.openai.com/v1"}/models`,
        headers: { authorization: `Bearer ${key}` },
        extract: (b) => (b.data as { id: string }[] | undefined)?.map((m) => m.id) ?? [],
      };
    case "google":
      return {
        url: `${config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"}/models?key=${key}`,
        headers: {},
        extract: (b) =>
          (b.models as { name: string }[] | undefined)?.map((m) =>
            m.name.replace(/^models\//, ""),
          ) ?? [],
      };
    case "openai-compatible":
      return {
        url: `${config.baseUrl}/models`,
        headers: key ? { authorization: `Bearer ${key}` } : {},
        extract: (b) => (b.data as { id: string }[] | undefined)?.map((m) => m.id) ?? [],
      };
  }
}

function toModelMessages(messages: Message[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    if (m.role === "user") return { role: "user", content: m.content };
    if (m.role === "assistant") {
      if (!m.toolCalls?.length) return { role: "assistant", content: m.content };
      return {
        role: "assistant",
        content: [
          ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
          ...m.toolCalls.map((c) => ({
            type: "tool-call" as const,
            toolCallId: c.id,
            toolName: c.name,
            input: c.input,
          })),
        ],
      };
    }
    return {
      role: "tool",
      content: m.results.map((r) => ({
        type: "tool-result" as const,
        toolCallId: r.callId,
        toolName: r.name,
        output: { type: "text" as const, value: r.output },
      })),
    };
  });
}

function toToolSet(tools: NonNullable<ChatRequest["tools"]>) {
  return Object.fromEntries(
    tools.map((t) => [
      t.name,
      // No `execute`: the loop dispatches tools itself so it can enforce budgets,
      // record every call, and stop on the terminal tool.
      makeTool({ description: t.description, inputSchema: jsonSchema(t.inputSchema) }),
    ]),
  );
}

function normaliseFinish(reason: string): FinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "tool-calls":
      return "tool-calls";
    case "length":
      return "length";
    case "content-filter":
      return "content-filter";
    case "error":
      return "error";
    default:
      return "other";
  }
}

interface SdkUsage {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    noCacheTokens?: number;
  };
}

/**
 * The SDK reports `inputTokens` as the TOTAL including cached tokens. Billing needs them
 * disjoint, so uncached input is derived by subtraction — otherwise cached tokens get
 * charged twice, at full rate and again at the cache rate.
 */
function normaliseUsage(usage: SdkUsage): Usage {
  const cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const total = usage.inputTokens ?? 0;
  const uncached =
    usage.inputTokenDetails?.noCacheTokens ?? Math.max(0, total - cacheRead - cacheWrite);
  return {
    inputTokens: uncached,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}
