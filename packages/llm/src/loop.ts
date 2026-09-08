import { type Logger, logger } from "@maestro/core";
import { costCents } from "./pricing.js";
import type { Provider } from "./provider.js";
import {
  addUsage,
  type ChatResponse,
  type Message,
  ProviderError,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
  type Usage,
  ZERO_USAGE,
} from "./types.js";

export interface Budget {
  maxSteps: number;
  costCapCents: number;
  maxTokens?: number;
  /** Wall-clock ceiling; a stuck agent must not hold an environment open forever. */
  deadlineMs?: number;
}

export type StopKind =
  | "terminal-tool"
  | "no-tool-calls"
  | "max-steps"
  | "cost-cap"
  | "token-cap"
  | "deadline"
  | "aborted";

export interface LoopStep {
  index: number;
  response: ChatResponse;
  toolResults: ToolResult[];
  costCents: number;
}

export interface LoopResult {
  steps: LoopStep[];
  usage: Usage;
  costCents: number;
  stopKind: StopKind;
  /** Input of the terminal tool call, when the agent finished properly. */
  terminalInput?: unknown;
  finalText: string;
  messages: Message[];
}

export type ToolDispatch = (call: ToolCall) => Promise<{ output: string; isError?: boolean }>;

export interface RunAgentOptions {
  provider: Provider;
  model: string;
  system: string;
  prompt: string;
  tools: ToolDefinition[];
  /** Reaching this tool ends the run; its input is the agent's real output. */
  terminalTool: string;
  dispatch: ToolDispatch;
  budget: Budget;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  onStep?: (step: LoopStep) => void | Promise<void>;
  /** Retry policy for transient provider failures. */
  maxRetriesPerStep?: number;
  /** Base for exponential backoff; lowered in tests to keep them fast. */
  backoffBaseMs?: number;
  /**
   * Steps remaining at which the agent is told to wrap up. Without this an exploratory
   * model spends its whole budget reading and never submits, which produces a review
   * with zero findings and full cost — the worst possible outcome.
   */
  wrapUpAtStepsRemaining?: number;
}

const DEFAULT_RETRIES = 3;

/**
 * Maestro's own agent loop.
 *
 * Owning this (rather than the SDK's multi-step helper) is what makes per-agent budgets,
 * honest token accounting and a terminal-tool contract possible. Budgets are enforced
 * post-hoc from reported usage plus a pre-call check — only Anthropic offers exact
 * pre-counting, so the loop is built to not need it.
 */
export async function runAgent(opts: RunAgentOptions): Promise<LoopResult> {
  const { provider, model, budget, terminalTool } = opts;
  const log = logger.child({ providerId: provider.id, model });
  const startedAt = Date.now();

  const messages: Message[] = [{ role: "user", content: opts.prompt }];
  const steps: LoopStep[] = [];
  let usage = ZERO_USAGE;
  let totalCost = 0;
  let finalText = "";
  let askedToSubmit = false;

  const stop = (stopKind: StopKind, terminalInput?: unknown): LoopResult => ({
    steps,
    usage,
    costCents: totalCost,
    stopKind,
    terminalInput,
    finalText,
    messages,
  });

  for (let index = 0; index < budget.maxSteps; index++) {
    if (opts.signal?.aborted) return stop("aborted");
    if (budget.deadlineMs && Date.now() - startedAt > budget.deadlineMs) return stop("deadline");
    // Checked before the call, because the cheapest way to respect a cap is not to spend.
    if (totalCost >= budget.costCapCents) return stop("cost-cap");
    if (budget.maxTokens && usage.inputTokens + usage.outputTokens >= budget.maxTokens) {
      return stop("token-cap");
    }

    const response = await callWithRetry(opts, messages, log, index);
    const stepCost = costCents(provider.kind, model, response.usage);
    usage = addUsage(usage, response.usage);
    totalCost += stepCost;
    if (response.text) finalText = response.text;

    if (!response.toolCalls.length) {
      const step: LoopStep = { index, response, toolResults: [], costCents: stepCost };
      steps.push(step);
      await opts.onStep?.(step);
      messages.push({ role: "assistant", content: response.text });

      // Some models answer in prose instead of calling the terminal tool. Discarding
      // that work outright wastes a whole agent run, so ask once, explicitly, before
      // giving up. Only once: a model that ignores the second ask will ignore a third.
      if (!askedToSubmit && index < budget.maxSteps - 1) {
        askedToSubmit = true;
        messages.push({
          role: "user",
          content:
            `You answered in prose, but only ${terminalTool} is recorded - anything outside that call is discarded. ` +
            `Call ${terminalTool} now with the findings from your analysis. An empty list is valid if you found nothing.`,
        });
        continue;
      }
      return stop("no-tool-calls");
    }

    messages.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls });

    // A terminal call ends the run. Any other calls in the same message are ignored:
    // once the agent has submitted its findings, further tool work is noise.
    const terminal = response.toolCalls.find((c) => c.name === terminalTool);
    if (terminal) {
      const step: LoopStep = { index, response, toolResults: [], costCents: stepCost };
      steps.push(step);
      await opts.onStep?.(step);
      return stop("terminal-tool", terminal.input);
    }

    // Parallel calls run concurrently; all results go back in ONE tool message, which is
    // what keeps models willing to keep issuing parallel calls.
    const toolResults = await Promise.all(
      response.toolCalls.map(async (call): Promise<ToolResult> => {
        try {
          const { output, isError } = await opts.dispatch(call);
          return { callId: call.id, name: call.name, output, isError };
        } catch (err) {
          return {
            callId: call.id,
            name: call.name,
            output: `error: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      }),
    );

    messages.push({ role: "tool", results: toolResults });

    // Budget awareness. A model that cannot see its own step budget will happily explore
    // until it is cut off; telling it how much room is left converts a wasted run into a
    // submitted one.
    const wrapUpAt = opts.wrapUpAtStepsRemaining ?? 3;
    const remaining = budget.maxSteps - index - 1;
    const nearCostCap = totalCost >= budget.costCapCents * 0.8;
    if (remaining > 0 && (remaining <= wrapUpAt || nearCostCap)) {
      messages.push({
        role: "user",
        content:
          `You have ${remaining} step${remaining === 1 ? "" : "s"} left` +
          (nearCostCap ? " and are near your cost budget" : "") +
          `. Stop investigating and call ${terminalTool} now with what you already have. ` +
          "Reporting fewer, well-supported findings is the expected outcome; an empty list is valid.",
      });
    }

    const step: LoopStep = { index, response, toolResults, costCents: stepCost };
    steps.push(step);
    await opts.onStep?.(step);
  }

  return stop("max-steps");
}

async function callWithRetry(
  opts: RunAgentOptions,
  messages: Message[],
  log: Logger,
  stepIndex: number,
): Promise<ChatResponse> {
  const attempts = opts.maxRetriesPerStep ?? DEFAULT_RETRIES;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await opts.provider.chat({
        model: opts.model,
        system: opts.system,
        messages,
        tools: opts.tools,
        temperature: opts.temperature,
        maxTokens: opts.maxOutputTokens,
        signal: opts.signal,
      });
    } catch (err) {
      lastError = err;
      const retryable = err instanceof ProviderError && err.opts.retryable;
      if (!retryable || attempt === attempts) break;
      const backoffMs = Math.min(2 ** attempt * (opts.backoffBaseMs ?? 500), 20_000);
      log.warn({ stepIndex, attempt, backoffMs, err }, "provider call failed, retrying");
      await sleep(backoffMs, opts.signal);
    }
  }
  throw lastError;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
