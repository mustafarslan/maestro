import type { ReviewOutcome } from "./engine.js";

const SEVERITY_ICON: Record<string, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🔵",
  info: "⚪",
};

/**
 * Renders the consolidated review comment.
 *
 * The metrics block reports only what is knowable at post time — what ran, what it
 * checked, what it cost. Accuracy figures are deliberately absent: precision and recall
 * need feedback that does not exist yet when the comment is written, and printing a
 * number you cannot compute is worse than printing none.
 */

/**
 * Everything below turns model- and author-written text into markdown that renders as
 * text.
 *
 * The comment is assembled by concatenation, and most of what goes into it originates
 * with whoever opened the pull request: `evidence` is quoted repository content, a
 * finding's title and body are a model's description of that content, a command is a
 * string an agent chose, a Linear title is whoever wrote the ticket. None of it was
 * escaped. A markdown file in the diff containing a code block was enough to break the
 * comment by accident; deliberately, it is a forged section inside Maestro's own review —
 * a "Approved by Maestro" heading below a fence the content closed itself.
 *
 * The agents hold no write credential precisely so that the orchestrator is the only
 * writer. That guarantee is about who posts, and it says nothing about what the posted
 * bytes mean once GitHub renders them.
 */

/** A fence longer than the longest backtick run inside, so content cannot close it. */
function fenced(text: string): string[] {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [fence, text, fence];
}

/** Inline code that a backtick in the content cannot escape. */
function code(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const longest = Math.max(0, ...[...flat.matchAll(/`+/g)].map((m) => m[0].length));
  const tick = "`".repeat(longest + 1);
  // A leading or trailing backtick in the content needs the padding space markdown
  // defines for exactly this case.
  return longest ? `${tick} ${flat} ${tick}` : `\`${flat}\``;
}

/** One line, for a heading or a table cell: a newline there ends the construct. */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

/** A table cell: a pipe closes the column and a newline ends the row. */
function cell(text: string): string {
  return oneLine(text).replace(/\|/g, "\\|");
}

/** Every line prefixed, or only the first line stays inside the quote. */
function quote(text: string): string {
  return text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

/**
 * Stops GitHub turning author-written text into notifications.
 *
 * `@name` in a comment notifies a real person and `#123` cross-links an issue. Both are
 * written by whoever opened the pull request — in a code comment an agent then quotes as
 * evidence — so without this, anyone can make Maestro ping arbitrary people and
 * back-reference arbitrary issues from a bot account the repository trusts. The HTML
 * comment is the standard neutraliser: it renders as nothing and breaks the token.
 */
function deactivate(text: string): string {
  return text.replace(/(^|[^\w`])([@#])(?=[\w-])/g, "$1$2<!---->");
}

/** Author- or model-written prose, rendered as prose and nothing else. */
function prose(text: string): string {
  return deactivate(text);
}

export function renderReview(outcome: ReviewOutcome, opts: { title?: string } = {}): string {
  const lines: string[] = [];
  const t = outcome.triage;

  lines.push(`## ${opts.title ?? "Maestro review"}`, "");

  if (outcome.state === "skipped") {
    lines.push(`Skipped: ${prose(oneLine(outcome.skipReason ?? ""))}`, "");
    return lines.join("\n");
  }
  if (outcome.state === "failed") {
    lines.push(quote(`Review failed: ${prose(oneLine(outcome.error ?? ""))}`), "");
  }
  if (t?.summary) lines.push(prose(t.summary), "");

  if (t?.posted.length) {
    for (const f of t.posted) {
      const where = f.file
        ? code(
            `${f.file}${f.lineStart ? `:${f.lineStart}${f.lineEnd && f.lineEnd !== f.lineStart ? `-${f.lineEnd}` : ""}` : ""}`,
          )
        : "_whole PR_";
      lines.push(`### ${SEVERITY_ICON[f.severity] ?? ""} ${prose(oneLine(f.title))}`);
      lines.push(
        `${where} · **${f.severity}** · ${code(f.category)} · confidence ${(f.confidence * 100).toFixed(0)}%` +
          (f.agreementCount > 1 ? ` · **${f.agreementCount} agents agree**` : "") +
          ` · _${f.agentIds.join(", ")}_`,
      );
      lines.push("", prose(f.body));
      // A second agent that described this location differently, kept rather than
      // dropped — one comment per location, but nothing an agent said is lost.
      for (const also of f.alsoReported ?? []) {
        lines.push(
          "",
          quote(`**Also reported here** (${also.agentId}) — ${prose(oneLine(also.title))}`),
          quote(prose(also.body)),
        );
      }
      if (f.evidence) lines.push("", ...fenced(f.evidence.slice(0, 1500)));
      lines.push("");
    }
  } else if (outcome.state === "done") {
    lines.push("No findings met the reporting threshold.", "");
  }

  // Degraded coverage belongs above the fold, not inside a collapsed block. "No findings"
  // reads as a clean bill of health, and it is not one when half the crew never ran: a
  // reader skimming the top line would take silence for a verdict. Observed on a real
  // run where two of three agents died on a provider quota and the headline still said
  // nothing was found.
  const failedAgents = outcome.nodes.filter((n) => n.kind === "agent" && n.state === "failed");
  if (failedAgents.length) {
    const names = failedAgents.map((n) => n.agentId ?? n.nodeId).join(", ");
    lines.push(
      `> **Partial review.** ${failedAgents.length} agent(s) did not complete: ${names}. ` +
        "Whatever they would have found is missing from this comment, so treat it as an " +
        "incomplete pass rather than a clean one.",
      "",
    );
  }

  lines.push("<details><summary>What Maestro checked</summary>", "");

  const agentRows = outcome.nodes.filter((n) => n.kind === "agent");
  if (agentRows.length) {
    lines.push(
      "| Agent | Status | Model | Findings | Cost | Time |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const n of agentRows) {
      lines.push(
        `| ${cell(n.agentId ?? "")} | ${n.state === "skipped" ? `skipped — ${cell(n.error ?? "")}` : n.state}` +
          ` | ${cell(n.model ?? "—")} | ${n.findings ?? "—"} | ${n.costCents ? `${n.costCents.toFixed(2)}¢` : "—"}` +
          ` | ${n.durationMs ? `${(n.durationMs / 1000).toFixed(1)}s` : "—"} |`,
      );
    }
    lines.push("");
  }

  const commands = agentRows.flatMap((n) => n.commandsRun ?? []);
  if (commands.length) {
    lines.push("**Commands executed**", "");
    for (const c of commands) {
      lines.push(
        c.refused
          ? `- ${code(c.command)} → **not allowlisted**, so it did not run`
          : `- ${code(c.command)} → exit ${c.exitCode} (${(c.durationMs / 1000).toFixed(1)}s)`,
      );
    }
    if (commands.some((c) => c.refused)) {
      lines.push(
        "",
        "> An agent asked for a command that is not on this repository's allowlist. That",
        "> usually means the toolchain was detected wrongly; set `envSpec.allowedCommands`",
        "> in the playbook, or `.maestro.yaml` on the base branch.",
      );
    }
    lines.push("");
  }

  if (t?.suppressed.length) {
    lines.push(
      `**Suppressed:** ${t.suppressed.length} finding(s) below threshold or over the comment cap.`,
      "",
    );
  }

  if (outcome.setupFailed) {
    lines.push(
      "> **Environment warning:** dependency installation did not complete, so build and test",
      "> commands may fail for reasons unrelated to this change. Findings that rest on command",
      "> output should be treated with caution.",
      "",
    );
  }

  const blocked = outcome.egressLog.filter((e) => !e.allowed);
  lines.push(
    // Whether ticket context was available changes how much weight the product agent's
    // verdict deserves, so the reader is told which issue was checked — or that none was.
    ...(outcome.linearIssue
      ? [
          `**Checked against** — Linear issue ${code(outcome.linearIssue.identifier)}: ${prose(oneLine(outcome.linearIssue.title))}` +
            (outcome.linearIssue.acceptanceCriteria
              ? " (acceptance criteria included)"
              : " (no acceptance criteria in the issue)"),
          "",
        ]
      : []),
    `**Environment** — toolchain \`${outcome.toolchain ?? "unknown"}\`, ` +
      // "analyzed with no network access" is the strong, enforced claim — `--network none`
      // on the analyze container, asserted in the integration suite by dialling an address
      // rather than by reading a flag. It is deliberately stated separately from anything
      // about the prepare phase, whose allowlist is advisory.
      `${outcome.allowedCommands.length} allowlisted command(s), analyzed with no network access.` +
      // Whether the dependency layer was reused. It is the difference between a review
      // that starts in seconds and one that reinstalls the world, and it was measured
      // and thrown away. Omitted entirely when the driver did not say, rather than
      // guessed at as a miss.
      (outcome.cacheHit === undefined
        ? ""
        : outcome.cacheHit
          ? " Dependency cache hit."
          : " Dependency cache miss — dependencies were installed from scratch.") +
      (blocked.length
        ? // "blocked" is true; "the only attempts" would not be. The proxy sees what the
          // installing tools chose to send through it — they are pointed at it with
          // HTTP_PROXY and honour it by convention — and traffic that ignores those
          // variables never appears in this log at all. Saying "blocked N attempts" and
          // stopping there invites the reader to conclude the phase was sealed, which is a
          // stronger claim than the evidence supports.
          // Attempts, not distinct hosts. The log is aggregated per host now, so counting
          // entries would have quietly turned "3000 blocked attempts" into "1" the moment
          // aggregation landed — a number that got smaller because the storage changed.
          ` ${blocked.reduce((n, e) => n + e.count, 0)} egress attempt(s) to ${blocked.length} host(s) blocked by the allowlist proxy during dependency install (proxy-routed traffic only).`
        : ""),
    "",
    `**Total** — ${outcome.costKnown === false ? "cost unpriced for this provider" : `${outcome.costCents.toFixed(2)}¢`}` +
      ` across ${agentRows.filter((n) => n.state === "done").length} agent(s) in ${(outcome.durationMs / 1000).toFixed(1)}s.`,
    "",
    "</details>",
  );

  return lines.join("\n");
}
