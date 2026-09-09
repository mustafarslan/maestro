import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { logger } from "@maestro/core";
import {
  APICallError,
  generateText,
  InvalidArgumentError,
  InvalidMessageRoleError,
  InvalidPromptError,
  InvalidToolInputError,
  JSONParseError,
  jsonSchema,
  type LanguageModel,
  LoadAPIKeyError,
  LoadSettingError,
  type ModelMessage,
  tool as makeTool,
  TypeValidationError,
  UnsupportedFunctionalityError,
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

  /**
   * Extended thinking, in the shape the target model actually accepts.
   *
   * `thinkingBudget` has been in the playbook schema and the Studio's model picker since
   * the beginning and was never read here — a knob that silently did nothing, like the
   * scheduler and the prompt budget before it.
   *
   * The shape is not one shape. Claude 4.6 and newer take `{ type: "adaptive" }` and
   * REJECT an explicit token budget with a 400; older models require
   * `{ type: "enabled", budgetTokens: N }`. Sending the older form to `claude-opus-5` —
   * which the shipped default playbook binds three agents to — would have failed every
   * call outright the moment anyone set the field.
   */
  private thinkingOptions(req: ChatRequest): Parameters<typeof generateText>[0]["providerOptions"] {
    if (!req.thinkingBudget || !this.capabilities(req.model).thinking) return undefined;

    if (this.kind === "anthropic") {
      return {
        anthropic: acceptsThinkingBudget(req.model)
          ? { thinking: { type: "enabled", budgetTokens: req.thinkingBudget } }
          : { thinking: { type: "adaptive" } },
      };
    }

    // Google takes the same unit Maestro already has — `thinkingConfig.thinkingBudget` is
    // a token count — so there is nothing to guess at. This was previously left undefined
    // alongside OpenAI, which meant a Google-bound agent silently ignored the field: the
    // Studio offered it, the schema carried it, and nothing happened.
    if (this.kind === "google") {
      return { google: { thinkingConfig: { thinkingBudget: req.thinkingBudget } } };
    }

    // OpenAI is deliberately still not mapped, and now for a stated reason rather than
    // caution: it takes `reasoningEffort`, an enum of "low" | "medium" | "high" | …, not a
    // token count. Turning a budget into one of those means inventing thresholds, and an
    // invented threshold that quietly changes what an agent costs is worse than a setting
    // that visibly does nothing. Said out loud rather than dropped in silence.
    if (!this.warnedThinkingIgnored) {
      this.warnedThinkingIgnored = true;
      logger.warn(
        { providerId: this.id, kind: this.kind, model: req.model },
        "thinkingBudget is set but this provider takes a reasoning EFFORT level, not a token " +
          "budget; the setting is ignored for this binding",
      );
    }
    return undefined;
  }

  /** One warning per provider instance, not one per model call. */
  private warnedThinkingIgnored = false;

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
        providerOptions: this.thinkingOptions(req),
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

    // Anything that is not an HTTP failure used to be retried, on the theory that it was
    // probably the network. Most of it is not. The reasoning already written above — "a
    // 400 means the request itself is wrong and retrying just burns budget" — applies
    // just as much to a prompt the SDK refused to build, an API key it could not load, or
    // a response that failed schema validation: none of those become true on the second
    // attempt, and a validation failure has already been paid for in tokens.
    //
    // Named rather than pattern-matched on the message, because the SDK exports these as
    // classes and matching on wording is a trap for whoever next reads a changelog.
    const permanent =
      InvalidPromptError.isInstance(err) ||
      InvalidArgumentError.isInstance(err) ||
      InvalidMessageRoleError.isInstance(err) ||
      InvalidToolInputError.isInstance(err) ||
      LoadAPIKeyError.isInstance(err) ||
      LoadSettingError.isInstance(err) ||
      TypeValidationError.isInstance(err) ||
      JSONParseError.isInstance(err) ||
      UnsupportedFunctionalityError.isInstance(err);

    return new ProviderError(message, {
      providerId: this.id,
      // A transport failure — `fetch failed`, a reset socket — is the case this fallback
      // is genuinely for, and it stays retryable.
      retryable: !isAbort && !permanent,
      cause: err,
    });
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

/**
 * Whether a model still takes an explicit thinking token budget.
 *
 * Claude 4.6 and later moved to adaptive thinking and reject `budget_tokens` with a 400.
 * Everything older still requires it. Defaulting to "adaptive" for unrecognised names is
 * the safer side of the line: a newer model is the likelier unknown, and adaptive is what
 * newer models want.
 */
function acceptsThinkingBudget(model: string): boolean {
  const legacy = [
    "claude-3-5",
    "claude-3-7",
    "claude-opus-4-0",
    "claude-opus-4-1",
    "claude-sonnet-4-0",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
  ];
  return legacy.some((prefix) => model.startsWith(prefix));
}
