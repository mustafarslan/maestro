import { logger } from "@maestro/core";
import { type LoopResult, type Provider, runAgent } from "@maestro/llm";
import {
  type Agent,
  buildAgentSystemPrompt,
  type PromptContext,
  wrapUntrusted,
} from "@maestro/playbook";
import type { Sandbox } from "@maestro/sandbox";
import { type Finding, SubmitFindingsSchema } from "./finding.js";
import { buildDispatch, TERMINAL_TOOL, type ToolContext, toolsForAgent } from "./tools.js";

export interface ReviewAgentRequest {
  agent: Agent;
  provider: Provider;
  model: string;
  sandbox: Sandbox;
  allowedCommands: string[];
  baseRef: string;
  commandTimeoutSec: number;
  context: PromptContext;
  budget: { maxSteps: number; costCapCents: number; deadlineMs?: number };
  signal?: AbortSignal;
  onStep?: (step: { index: number; costCents: number }) => void;
}

export interface ReviewAgentResult {
  agentId: string;
  findings: Finding[];
  summary?: string;
  loop: LoopResult;
  commandLog: { command: string; exitCode: number; durationMs: number }[];
  /** Set when the agent produced no valid structured output. */
  parseError?: string;
}

/**
 * Runs one specialist agent against a prepared sandbox.
 *
 * The agent's real output is the input to its terminal `submit_findings` call — free
 * prose is discarded. That contract is what makes triage's job tractable and what stops
 * a chatty model from smuggling unstructured claims into a PR comment.
 */
export async function runReviewAgent(req: ReviewAgentRequest): Promise<ReviewAgentResult> {
  const log = logger.child({ agentId: req.agent.id, model: req.model });
  const commandLog: ToolContext["commandLog"] = [];

  const ctx: ToolContext = {
    sandbox: req.sandbox,
    allowedCommands: req.allowedCommands,
    baseRef: req.baseRef,
    commandTimeoutSec: req.commandTimeoutSec,
    commandLog,
  };

  const system = buildAgentSystemPrompt(req.agent, req.context);
  const prompt = buildUserPrompt(req.context, req.allowedCommands);

  const loop = await runAgent({
    provider: req.provider,
    model: req.model,
    system,
    prompt,
    tools: toolsForAgent(req.agent.tools),
    terminalTool: TERMINAL_TOOL,
    dispatch: buildDispatch(ctx),
    budget: req.budget,
    temperature: req.agent.model.temperature,
    maxOutputTokens: req.agent.model.maxTokens,
    signal: req.signal,
    onStep: (s) => req.onStep?.({ index: s.index, costCents: s.costCents }),
  });

  if (loop.stopKind !== "terminal-tool") {
    // Running out of budget is a normal outcome, not a crash; the review proceeds with
    // whatever the other agents found and the metrics block records why this one stopped.
    log.warn(
      { stopKind: loop.stopKind, steps: loop.steps.length },
      "agent did not reach submit_findings",
    );
    return {
      agentId: req.agent.id,
      findings: [],
      loop,
      commandLog,
      parseError: `agent stopped with '${loop.stopKind}' before submitting findings`,
    };
  }

  const parsed = SubmitFindingsSchema.safeParse(loop.terminalInput);
  if (!parsed.success) {
    log.warn({ issues: parsed.error.issues }, "submit_findings failed schema validation");
    return {
      agentId: req.agent.id,
      findings: [],
      loop,
      commandLog,
      parseError: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }

  log.info({ findings: parsed.data.findings.length, costCents: loop.costCents }, "agent finished");
  return {
    agentId: req.agent.id,
    findings: parsed.data.findings,
    summary: parsed.data.summary,
    loop,
    commandLog,
  };
}

function buildUserPrompt(ctx: PromptContext, allowedCommands: string[]): string {
  const parts: string[] = ["Review the pull request described below."];

  if (ctx.pr?.title || ctx.pr?.description) {
    // Author-controlled text is fenced and labelled as data, every time.
    parts.push(
      wrapUntrusted(
        "pull-request",
        [
          ctx.pr.title ? `Title: ${ctx.pr.title}` : "",
          ctx.pr.author ? `Author: ${ctx.pr.author}` : "",
          ctx.pr.description ? `Description:\n${ctx.pr.description}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    );
  }

  if (ctx.linear?.title || ctx.linear?.acceptanceCriteria) {
    parts.push(
      wrapUntrusted(
        "linear-issue",
        [
          ctx.linear.identifier ? `Issue: ${ctx.linear.identifier}` : "",
          ctx.linear.title ? `Title: ${ctx.linear.title}` : "",
          ctx.linear.description ? `Description:\n${ctx.linear.description}` : "",
          ctx.linear.acceptanceCriteria
            ? `Acceptance criteria:\n${ctx.linear.acceptanceCriteria}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    );
  }

  if (ctx.diff?.changedFiles?.length) {
    const shown = ctx.diff.changedFiles.slice(0, 100);
    parts.push(
      `Changed files (${ctx.diff.changedFiles.length}${ctx.diff.changedLines ? `, ~${ctx.diff.changedLines} lines` : ""}):\n` +
        shown.map((f) => `  ${f}`).join("\n") +
        (ctx.diff.changedFiles.length > shown.length
          ? `\n  ... and ${ctx.diff.changedFiles.length - shown.length} more`
          : ""),
    );
  }

  parts.push(
    "Start with git_diff to see the change, then read the surrounding code before judging it.",
    allowedCommands.length
      ? `You may run these commands to verify a suspicion:\n${allowedCommands.map((c) => `  ${c}`).join("\n")}`
      : "No commands are available in this environment; reason from the code alone.",
    `When you are done, call ${TERMINAL_TOOL}. Reporting nothing is better than reporting noise.`,
  );

  return parts.join("\n\n");
}
