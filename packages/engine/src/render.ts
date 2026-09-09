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
export function renderReview(outcome: ReviewOutcome, opts: { title?: string } = {}): string {
  const lines: string[] = [];
  const t = outcome.triage;

  lines.push(`## ${opts.title ?? "Maestro review"}`, "");

  if (outcome.state === "skipped") {
    lines.push(`Skipped: ${outcome.skipReason}`, "");
    return lines.join("\n");
  }
  if (outcome.state === "failed") {
    lines.push(`> Review failed: ${outcome.error}`, "");
  }
  if (t?.summary) lines.push(t.summary, "");

  if (t?.posted.length) {
    for (const f of t.posted) {
      const where = f.file
        ? `\`${f.file}${f.lineStart ? `:${f.lineStart}${f.lineEnd && f.lineEnd !== f.lineStart ? `-${f.lineEnd}` : ""}` : ""}\``
        : "_whole PR_";
      lines.push(`### ${SEVERITY_ICON[f.severity] ?? ""} ${f.title}`);
      lines.push(
        `${where} · **${f.severity}** · \`${f.category}\` · confidence ${(f.confidence * 100).toFixed(0)}%` +
          (f.agreementCount > 1 ? ` · **${f.agreementCount} agents agree**` : "") +
          ` · _${f.agentIds.join(", ")}_`,
      );
      lines.push("", f.body);
      // A second agent that described this location differently, kept rather than
      // dropped — one comment per location, but nothing an agent said is lost.
      for (const also of f.alsoReported ?? []) {
        lines.push(
          "",
          `> **Also reported here** (${also.agentId}) — ${also.title}`,
          `> ${also.body}`,
        );
      }
      if (f.evidence) lines.push("", "```", f.evidence.slice(0, 1500), "```");
      lines.push("");
    }
  } else if (outcome.state === "done") {
    lines.push("No findings met the reporting threshold.", "");
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
        `| ${n.agentId} | ${n.state === "skipped" ? `skipped — ${n.error ?? ""}` : n.state}` +
          ` | ${n.model ?? "—"} | ${n.findings ?? "—"} | ${n.costCents ? `${n.costCents.toFixed(2)}¢` : "—"}` +
          ` | ${n.durationMs ? `${(n.durationMs / 1000).toFixed(1)}s` : "—"} |`,
      );
    }
    lines.push("");
  }

  const commands = agentRows.flatMap((n) => n.commandsRun ?? []);
  if (commands.length) {
    lines.push("**Commands executed**", "");
    for (const c of commands) {
      lines.push(`- \`${c.command}\` → exit ${c.exitCode} (${(c.durationMs / 1000).toFixed(1)}s)`);
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
          `**Checked against** — Linear issue \`${outcome.linearIssue.identifier}\`: ${outcome.linearIssue.title}` +
            (outcome.linearIssue.acceptanceCriteria
              ? " (acceptance criteria included)"
              : " (no acceptance criteria in the issue)"),
          "",
        ]
      : []),
    `**Environment** — toolchain \`${outcome.toolchain ?? "unknown"}\`, ` +
      `${outcome.allowedCommands.length} allowlisted command(s), analyzed with no network access.` +
      (blocked.length
        ? ` ${blocked.length} egress attempt(s) blocked during dependency install.`
        : ""),
    "",
    `**Total** — ${outcome.costKnown === false ? "cost unpriced for this provider" : `${outcome.costCents.toFixed(2)}¢`}` +
      ` across ${agentRows.filter((n) => n.state === "done").length} agent(s) in ${(outcome.durationMs / 1000).toFixed(1)}s.`,
    "",
    "</details>",
  );

  return lines.join("\n");
}
