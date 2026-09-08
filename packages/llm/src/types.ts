export type ProviderKind = "anthropic" | "openai" | "google" | "openai-compatible";

export interface ModelCapabilities {
  tools: boolean;
  jsonSchema: boolean;
  thinking: boolean;
  vision: boolean;
  caching: boolean;
  contextWindow?: number;
}

export interface ModelInfo {
  id: string;
  displayName?: string;
  capabilities: ModelCapabilities;
  inputCostPerMTok?: number;
  outputCostPerMTok?: number;
}

/** Normalised across providers. Cache fields are zero where a provider has no cache concept. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema. Kept as raw schema rather than zod so playbook-defined tools stay data. */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  callId: string;
  name: string;
  /** Stringified for the model; structured payloads are serialised by the caller. */
  output: string;
  isError?: boolean;
}

export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; results: ToolResult[] };

export interface ChatRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** Provider-specific; ignored where unsupported. */
  thinkingBudget?: number;
  signal?: AbortSignal;
}

export type FinishReason = "stop" | "tool-calls" | "length" | "content-filter" | "error" | "other";

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: Usage;
  latencyMs: number;
  model: string;
  providerId: string;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly opts: {
      providerId: string;
      status?: number;
      /** Drives retry policy: rate limits and 5xx are worth retrying, 400s are not. */
      retryable: boolean;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
