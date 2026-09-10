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
  /**
   * Approximate character ceiling for the conversation sent to the model.
   *
   * Tool results accumulate without bound - a few large files or a big diff will
   * eventually exceed any context window, and the provider rejects the whole request.
   * Losing an agent's entire run to that is far worse than dropping its oldest reads.
   */
  maxPromptChars?: number;
}

export type StopKind =
  | "terminal-tool"
  | "no-tool-calls"
  | "max-steps"
  | "cost-cap"
  | "token-cap"
  | "deadline"
  | "context-limit"
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
  /** Extended thinking. The provider translates it to the shape its model accepts. */
  thinkingBudget?: number;
  signal?: AbortSignal;
  onStep?: (step: LoopStep) => void | Promise<void>;
  /**
   * Logger to hang this run's lines off, so they carry the review, node and agent they
   * belong to. Without it the loop logged only provider and model, and a retry or a
   * context-window warning could not be attributed to any particular agent — with
   * several reviews in flight, that is most of what the logs are for.
   */
  log?: Logger;
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
  const log = (opts.log ?? logger).child({ providerId: provider.id, model });
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

    // Keep the conversation inside the model's window. Roughly four characters per
    // token is close enough for a guard whose job is to avoid a hard rejection.
    const dropped = trimHistory(messages, budget.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS);
    if (dropped) log.warn({ dropped }, "trimmed oldest tool results to fit the context window");

    let response: ChatResponse;
    try {
      response = await callWithRetry(opts, messages, log, index);
    } catch (err) {
      if (isContextLimitError(err)) {
        // Returning what the agent has beats losing the entire run.
        log.warn({ err: err instanceof Error ? err.message : err }, "context window exceeded");
        return stop("context-limit");
      }
      throw err;
    }
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

    // Copied, not shared. `trimHistory`'s last resort truncates oversized tool outputs
    // in place on the objects inside `messages` — and those were the very same objects,
    // so a step quietly lost the same bytes the prompt did. Trimming the prompt is right;
    // a recorded transcript that matches the trimmed prompt rather than what the tool
    // actually returned is not, and it is the whole reason the recorder reads steps
    // instead of messages. The copy is taken here, before the next iteration can trim.
    const step: LoopStep = {
      index,
      response,
      toolResults: toolResults.map((r) => ({ ...r })),
      costCents: stepCost,
    };
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
        thinkingBudget: opts.thinkingBudget,
        signal: opts.signal,
      });
    } catch (err) {
      lastError = err;
      // An oversized prompt will be oversized again; retrying only burns budget.
      if (isContextLimitError(err)) throw err;
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

const DEFAULT_MAX_PROMPT_CHARS = 400_000;

/**
 * Drops the oldest tool results until the conversation fits.
 *
 * The task and the most recent exchanges are what the model actually needs; a file it
 * read fifteen steps ago is the cheapest thing to lose. Returns how many were dropped.
 */
export function trimHistory(messages: Message[], maxChars: number): number {
  const size = () => messages.reduce((n, m) => n + JSON.stringify(m).length, 0);
  if (size() <= maxChars) return 0;

  let dropped = 0;
  // Assistant tool-calls and their tool results must be dropped as a PAIR. Removing a
  // tool message alone orphans the call it answered, and providers reject the request
  // outright with "tool result is missing" - which would break exactly the long runs
  // this trimming exists to rescue.
  //
  // Index 0 (the task) and the last four messages (the live exchange) are never touched.
  // The bound is -5, not -4: splice(i, 2) at i = length-5 would remove length-4, which
  // is inside the live exchange this loop promises never to touch.
  for (let i = 1; i < messages.length - 5 && size() > maxChars; ) {
    const current = messages[i];
    const next = messages[i + 1];
    if (current?.role === "assistant" && current.toolCalls?.length && next?.role === "tool") {
      messages.splice(i, 2);
      dropped += 2;
      continue;
    }
    i++;
  }

  // Still too large: the remaining results are individually huge, so truncate them.
  if (size() > maxChars) {
    for (const m of messages) {
      if (m.role !== "tool") continue;
      for (const r of m.results) {
        if (r.output.length > 4_000) {
          r.output = `${r.output.slice(0, 4_000)}\n... [truncated to fit the context window]`;
        }
      }
    }
  }
  return dropped;
}

/** Providers word this differently; all of them mean the same unrecoverable thing. */
function isContextLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /context length|context window|too long|maximum context|prompt is too long/i.test(message);
}
