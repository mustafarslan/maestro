import { runAgent } from "./loop.js";
import type { Provider } from "./provider.js";
import type { ModelCapabilities, ToolDefinition } from "./types.js";

/**
 * The contract every provider adapter must satisfy.
 *
 * Runs against a live provider or a replayed fixture — the adapter cannot tell the
 * difference, because `fetch` is injected. This is what stops "it works on Anthropic"
 * from being the whole test suite, and it is also how Ollama's per-model tool support
 * gets *discovered* rather than assumed: a failure downgrades the capability flag
 * instead of failing the run.
 */

export const ECHO_TOOL: ToolDefinition = {
  name: "echo",
  description: "Echo a value back. Used to verify tool calling works.",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string", description: "the value to echo" } },
    required: ["value"],
    additionalProperties: false,
  },
};

export const SUBMIT_TOOL: ToolDefinition = {
  name: "submit",
  description: "Submit the final answer. Call this exactly once when you are done.",
  inputSchema: {
    type: "object",
    properties: { answer: { type: "string" }, confidence: { type: "number" } },
    required: ["answer"],
    additionalProperties: false,
  },
};

export interface ConformanceCheck {
  name: string;
  passed: boolean;
  detail: string;
  durationMs: number;
}

export interface ConformanceReport {
  providerId: string;
  model: string;
  checks: ConformanceCheck[];
  /** Capabilities as OBSERVED, which may downgrade the static table for this model. */
  observed: Partial<ModelCapabilities>;
  passed: boolean;
  costCents: number;
}

async function timed(name: string, fn: () => Promise<string>): Promise<ConformanceCheck> {
  const started = Date.now();
  try {
    const detail = await fn();
    return { name, passed: true, detail, durationMs: Date.now() - started };
  } catch (err) {
    return {
      name,
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  }
}

export async function runConformance(
  provider: Provider,
  model: string,
): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];
  const observed: Partial<ModelCapabilities> = {};
  let costCents = 0;

  checks.push(
    await timed("plain completion", async () => {
      const res = await provider.chat({
        model,
        system: "Answer with a single word.",
        messages: [{ role: "user", content: "What is the capital of France?" }],
        maxTokens: 64,
      });
      if (!res.text.trim()) throw new Error("empty response text");
      return res.text.trim().slice(0, 60);
    }),
  );

  const toolCheck = await timed("tool call", async () => {
    const res = await provider.chat({
      model,
      system: "You must use the echo tool.",
      messages: [{ role: "user", content: "Echo the word 'maestro'." }],
      tools: [ECHO_TOOL],
      maxTokens: 256,
    });
    if (!res.toolCalls.length) throw new Error("model returned no tool calls");
    const call = res.toolCalls[0];
    if (call?.name !== "echo") throw new Error(`unexpected tool: ${call?.name}`);
    if (typeof (call.input as { value?: unknown })?.value !== "string") {
      throw new Error("tool input did not match the schema");
    }
    return `called ${call.name}(${JSON.stringify(call.input)})`;
  });
  checks.push(toolCheck);
  // Ollama tool support is per-model: record what is true rather than failing the run.
  observed.tools = toolCheck.passed;

  if (toolCheck.passed) {
    checks.push(
      await timed("multi-turn tool loop with terminal tool", async () => {
        const result = await runAgent({
          provider,
          model,
          system: "Use the echo tool once, then call submit with the echoed value.",
          prompt: "Echo 'ping', then submit the answer.",
          tools: [ECHO_TOOL, SUBMIT_TOOL],
          terminalTool: "submit",
          dispatch: async (call) => ({ output: JSON.stringify(call.input) }),
          budget: { maxSteps: 5, costCapCents: 25 },
        });
        costCents += result.costCents;
        if (result.stopKind !== "terminal-tool") {
          throw new Error(`loop ended with '${result.stopKind}', expected terminal-tool`);
        }
        return `${result.steps.length} step(s), stop=${result.stopKind}`;
      }),
    );
  }

  checks.push(
    await timed("usage accounting", async () => {
      const res = await provider.chat({
        model,
        messages: [{ role: "user", content: "Say 'ok'." }],
        maxTokens: 32,
      });
      if (res.usage.inputTokens <= 0 && res.usage.cacheReadTokens <= 0) {
        throw new Error("provider reported no input tokens");
      }
      return `in=${res.usage.inputTokens} out=${res.usage.outputTokens} cacheRead=${res.usage.cacheReadTokens}`;
    }),
  );

  checks.push(
    await timed("error mapping", async () => {
      try {
        await provider.chat({
          model: "definitely-not-a-real-model-xyz",
          messages: [{ role: "user", content: "hi" }],
          maxTokens: 8,
        });
      } catch (err) {
        const e = err as { name?: string; opts?: { retryable?: boolean; status?: number } };
        if (e.name !== "ProviderError") throw new Error(`unmapped error type: ${e.name}`);
        return `mapped (status=${e.opts?.status ?? "n/a"}, retryable=${e.opts?.retryable})`;
      }
      throw new Error("a bogus model id did not raise");
    }),
  );

  return {
    providerId: provider.id,
    model,
    checks,
    observed,
    // Tool support is informational for openai-compatible models; the rest must pass.
    passed: checks.every((c) => c.passed || c.name === "tool call"),
    costCents,
  };
}
