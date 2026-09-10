import { taskLogger } from "@maestro/core";
import { type LoopResult, type Provider, runAgent } from "@maestro/llm";
import {
  type Agent,
  buildAgentSystemPrompt,
  type PromptContext,
  wrapUntrusted,
} from "@maestro/playbook";
import type { CommandComparison, Sandbox } from "@maestro/sandbox";
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
  /**
   * What the configured commands did at the merge base and at the head.
   *
   * Maestro's own measurement. Handed to the agent as trusted evidence, and labelled as
   * such in the prompt, so a pull request's claim about being faster or fixing a test can
   * be checked against something rather than taken at its word.
   */
  comparisons?: CommandComparison[];
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
  /**
   * What this run was actually asked, verbatim.
   *
   * Both halves are composed here and were previously unrecoverable afterwards: the
   * system prompt is rebuilt from a persona that a later publish may have changed, and
   * the user prompt carries the diff and the ticket, which are not stored anywhere at
   * all. Returning them is what lets the recorder write a trajectory somebody can read
   * without re-fetching the pull request at its old head.
   */
  prompts: { system: string; user: string };
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
    req.comparisons,
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
      prompts: { system, user: prompt },
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
      prompts: { system, user: prompt },
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
    prompts: { system, user: prompt },
  };
}

function buildUserPrompt(
  ctx: PromptContext,
  allowedCommands: string[],
  setupFailed?: boolean,
  writableWorkdir?: boolean,
  comparisons?: CommandComparison[],
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

  const measured = renderComparisons(comparisons);
  if (measured) parts.push(measured);

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
 * What Maestro measured at the merge base and at the head.
 *
 * This is the first evidence an agent is *given* rather than fetches, which is why its
 * provenance is spelled out in the text instead of being left implied. Everything else
 * factual in this prompt arrived through a tool the agent called; the pull request's own
 * claims arrive fenced and labelled as author-written data. This block sits outside every
 * fence and says so, because the entire value of the feature is that a claim and a
 * measurement cannot be mistaken for one another.
 *
 * The instruction is deliberately strict about what counts. An agent handed two timings
 * will otherwise announce a speedup, and a timing taken in a shared 2-CPU container is
 * not evidence of one.
 */
function renderComparisons(comparisons?: CommandComparison[]): string {
  if (!comparisons?.length) return "";

  const skipped = comparisons.filter(
    (c): c is CommandComparison & { skipped: NonNullable<CommandComparison["skipped"]> } =>
      c.skipped !== undefined,
  );
  const ran = comparisons.filter((c) => !c.skipped);

  const lines: string[] = [
    "MEASURED BY MAESTRO (trusted; not from the pull request author).",
    "Each command below was run twice: once at the merge base — the commit this pull " +
      "request was written against — and once at its head, in containers with identical " +
      "cpu, memory and process limits.",
  ];

  for (const c of ran) {
    const base = c.base;
    const head = c.head;
    if (!base || !head) continue;
    const verdict =
      c.verdict === "fixed"
        ? "exit code changed from failing to passing"
        : c.verdict === "broken"
          ? "exit code changed from passing to failing"
          : `both runs exited ${head.exitCode}`;
    lines.push(
      `$ ${c.command}\n` +
        `  merge base: exit ${base.exitCode}${base.timedOut ? " (timed out)" : ""}\n` +
        `  head:       exit ${head.exitCode}${head.timedOut ? " (timed out)" : ""}\n` +
        `  ${verdict}\n` +
        `  timings (ms) base ${base.durationsMs.join(", ")} | head ${head.durationsMs.join(", ")}` +
        `  — measured with ${head.concurrentAgents} other agent container(s) running\n` +
        `  head stdout (tail):\n${indent(head.stdoutTail)}\n` +
        `  merge-base stdout (tail):\n${indent(base.stdoutTail)}`,
    );
  }

  for (const c of skipped) {
    lines.push(
      `$ ${c.command}\n  NOT RUN (${skipReason(c.skipped)}). Treat this claim as unchecked.`,
    );
  }

  lines.push(
    "How to use this: a comparative claim in the pull request — faster, smaller, fixes " +
      "the failing test — is VERIFIED only where a measured exit-code change supports it. " +
      "Timing differences are NOT evidence: these ran on a shared host under concurrent " +
      "load, and the numbers are indicative only. Output differences are for you to read " +
      "and judge, not a verdict in themselves. Where the measurements do not cover a " +
      "claim, say the claim is unverified rather than assuming either way.",
  );

  return lines.join("\n\n");
}

function skipReason(skip: NonNullable<CommandComparison["skipped"]>): string {
  switch (skip) {
    case "untrusted":
      return "fork pull requests execute no commands";
    case "no-merge-base":
      return "the fork point could not be found, so there is no baseline";
    case "base-prepare-failed":
      return "the merge-base environment could not be prepared";
    case "not-runnable":
      return "the command does not exist at the merge base — it is new in this pull request";
    default:
      return "not configured";
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
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
