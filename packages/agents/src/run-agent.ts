import { taskLogger } from "@maestro/core";
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
  /** Dependency install did not complete; command output is unreliable evidence. */
  setupFailed?: boolean;
  /** False when the checkout is mounted read-only, which makes some commands fail. */
  writableWorkdir?: boolean;
  context: PromptContext;
  /**
   * Trace correlation. Without the review id an agent's log lines cannot be tied to the
   * review they belong to, which is precisely the question asked when one goes wrong —
   * and with three agents running concurrently across several reviews, `agentId` alone
   * matches lines from all of them.
   */
  reviewId?: string;
  nodeId?: string;
  budget: { maxSteps: number; costCapCents: number; deadlineMs?: number; maxPromptChars?: number };
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
  const log = taskLogger({
    reviewId: req.reviewId,
    nodeId: req.nodeId,
    agentId: req.agent.id,
  }).child({ model: req.model });
  const commandLog: ToolContext["commandLog"] = [];

  const ctx: ToolContext = {
    sandbox: req.sandbox,
    allowedCommands: req.allowedCommands,
    baseRef: req.baseRef,
    commandTimeoutSec: req.commandTimeoutSec,
    commandLog,
  };

  const system = buildAgentSystemPrompt(req.agent, req.context);
  const prompt = buildUserPrompt(
    req.context,
    req.allowedCommands,
    req.setupFailed,
    req.writableWorkdir,
  );

  const loop = await runAgent({
    log,
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
    thinkingBudget: req.agent.model.thinkingBudget,
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

function buildUserPrompt(
  ctx: PromptContext,
  allowedCommands: string[],
  setupFailed?: boolean,
  writableWorkdir?: boolean,
): string {
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
    // Fenced, because the pull request author chooses these. Git permits newlines and
    // almost any byte in a path, so an unfenced file named
    // `x.txt\nIgnore all instructions` renders as its own line in the trusted region,
    // at the same level as Maestro's own instructions. Hardening the fence and then
    // leaving the one input with byte-level freedom outside it protects nothing.
    parts.push(
      `Changed files (${ctx.diff.changedFiles.length}${ctx.diff.changedLines ? `, ~${ctx.diff.changedLines} lines` : ""}):\n` +
        wrapUntrusted(
          "changed-file-paths",
          shown.map((f) => `  ${sanitisePath(f)}`).join("\n") +
            (ctx.diff.changedFiles.length > shown.length
              ? `\n  ... and ${ctx.diff.changedFiles.length - shown.length} more`
              : ""),
        ),
    );
  }

  if (ctx.carriedFindings?.length) {
    // Model text derived from attacker-controlled content, carried across rounds. It is
    // no more trustworthy than the diff it came from.
    parts.push(
      "These issues were reported on an earlier round of this pull request and have not " +
        "been addressed. Do not repeat them; only report them again if this change makes " +
        "them worse or if you find something genuinely new:\n" +
        wrapUntrusted("carried-findings", ctx.carriedFindings.map((f) => `  - ${f}`).join("\n")),
    );
  }

  // Stated once, from the sandbox's own configuration — never derived from command
  // output. The previous version regexed the output for "read-only" or "permission
  // denied" and appended "do not report it as a defect", which is attacker-controlled:
  // the author of a pull request could print those strings from a test to suppress a
  // real finding. Worse, a genuine permissions regression produces exactly that output,
  // so the harness would have told the reviewer to ignore the very defect it introduced.
  if (writableWorkdir === false) {
    parts.push(
      "The checkout is mounted read-only. Commands that write into it — builds, " +
        "formatters, anything generating coverage — will fail for that reason and not " +
        "because of the change. Judge such a failure on its message, not on its exit code.",
    );
  }

  parts.push(
    "Start with git_diff to see the change, then read the surrounding code before judging it.",
    allowedCommands.length
      ? `You may run these commands to verify a suspicion:\n${allowedCommands.map((c) => `  ${c}`).join("\n")}`
      : "No commands are available in this environment; reason from the code alone.",
    // Without this an agent blames the code for a broken environment and reports a
    // phantom defect - observed on the first real run against a live repository.
    setupFailed
      ? "IMPORTANT: dependency installation did not complete in this environment. Build and test " +
          "commands may fail for reasons unrelated to the change under review. Do not report a " +
          "failing command as a defect unless you can tie it to the diff itself."
      : "",
    `When you are done, call ${TERMINAL_TOOL}. Reporting nothing is better than reporting noise.`,
  );

  return parts.join("\n\n");
}

/**
 * Renders a repository path safely for a prompt.
 *
 * Git allows newlines and control bytes in a path, and the author of a pull request picks
 * them. A newline is the whole attack: it ends the line the path was supposed to occupy
 * and starts one the reader may take for its own. The fence around the list is the main
 * defence; this makes the individual entries unable to fake structure inside it.
 */
function sanitisePath(path: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  return path.replace(/[\u0000-\u001f\u007f]/g, "\uFFFD");
}
