import type { ProviderConfig } from "./provider.js";
import type { ProviderKind } from "./types.js";

/**
 * Recorded-response transport.
 *
 * Every adapter takes an injectable `fetch`, so the conformance suite and the unit tests
 * run offline against canned wire-format responses. Without this, testing four providers
 * would require four API keys and a network, and CI would be permanently red.
 */

export interface AnthropicTurn {
  text?: string;
  toolCalls?: { id: string; name: string; input: unknown }[];
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  stopReason?: string;
}

export interface FakeTransport {
  fetch: typeof globalThis.fetch;
  /** Bodies of every request made, so tests can assert what was actually sent. */
  requests: { url: string; body: Record<string, unknown> }[];
}

export function anthropicTransport(turns: AnthropicTurn[]): FakeTransport {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  let call = 0;

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });

    if (url.includes("/v1/models")) {
      return json({
        data: [{ id: "claude-opus-5" }, { id: "claude-sonnet-5" }, { id: "claude-haiku-4-5" }],
      });
    }

    const turn = turns[Math.min(call++, turns.length - 1)];
    if (!turn) return json({ type: "error", error: { message: "no turn scripted" } }, 500);

    const content: Record<string, unknown>[] = [];
    if (turn.text) content.push({ type: "text", text: turn.text });
    for (const c of turn.toolCalls ?? []) {
      content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
    }

    return json({
      id: `msg_${call}`,
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content,
      stop_reason: turn.stopReason ?? (turn.toolCalls?.length ? "tool_use" : "end_turn"),
      usage: {
        input_tokens: turn.usage?.input ?? 100,
        output_tokens: turn.usage?.output ?? 25,
        cache_read_input_tokens: turn.usage?.cacheRead ?? 0,
        cache_creation_input_tokens: turn.usage?.cacheWrite ?? 0,
      },
    });
  };

  return { fetch: fetchImpl, requests };
}

/** Always fails with the given status: exercises retry and error-mapping paths. */
export function failingTransport(status: number, message = "boom"): FakeTransport {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return json({ type: "error", error: { type: "api_error", message } }, status);
  };
  return { fetch: fetchImpl, requests };
}

/** Fails `failures` times, then succeeds: proves retries actually recover. */
export function flakyTransport(failures: number, status = 429): FakeTransport {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  let n = 0;
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    if (n++ < failures) return json({ type: "error", error: { message: "rate limited" } }, status);
    return json({
      id: "msg_ok",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "text", text: "recovered" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  };
  return { fetch: fetchImpl, requests };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function fakeConfig(
  transport: FakeTransport,
  over: Partial<ProviderConfig> = {},
): ProviderConfig {
  const kind: ProviderKind = over.kind ?? "anthropic";
  return {
    id: over.id ?? kind,
    kind,
    apiKey: "sk-test",
    fetch: transport.fetch,
    ...over,
  };
}
