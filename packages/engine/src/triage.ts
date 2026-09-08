import type { Finding, Severity } from "@maestro/agents";
import type { PlaybookDocument } from "@maestro/playbook";

export interface AgentFindings {
  agentId: string;
  findings: Finding[];
  summary?: string;
}

export interface TriagedFinding extends Finding {
  agentIds: string[];
  /** How many independent agents raised the same defect. Agreement is evidence. */
  agreementCount: number;
  suppressedReason?: string;
}

export interface TriageResult {
  posted: TriagedFinding[];
  suppressed: TriagedFinding[];
  summary: string;
}

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/**
 * Deterministic triage.
 *
 * Merges, calibrates and ranks findings from agents that worked independently and could
 * not see each other's output. This is the noise gate: the single thing that decides
 * whether people keep reading Maestro's comments or learn to scroll past them.
 *
 * An LLM triage pass replaces the narrative in a later phase; the mechanical parts
 * (dedupe, agreement, thresholds, caps) stay here because they should be predictable
 * and testable rather than re-litigated by a model on every run.
 */
export function triage(doc: PlaybookDocument, inputs: AgentFindings[]): TriageResult {
  const { minConfidence, maxInlineComments, agreementBoost } = doc.triage;

  const groups = new Map<string, TriagedFinding>();

  for (const { agentId, findings } of inputs) {
    for (const finding of findings) {
      const key = dedupeKey(finding);
      const existing = groups.get(key);

      if (!existing) {
        groups.set(key, { ...finding, agentIds: [agentId], agreementCount: 1 });
        continue;
      }

      // Two agents describing the same defect is corroboration, not a reason to say it
      // twice. Keep the more confident statement and raise confidence for the agreement.
      existing.agentIds.push(agentId);
      existing.agreementCount += 1;
      existing.confidence = Math.min(
        1,
        Math.max(existing.confidence, finding.confidence) + agreementBoost,
      );
      if (SEVERITY_RANK[finding.severity] < SEVERITY_RANK[existing.severity]) {
        existing.severity = finding.severity;
      }
      if (finding.body.length > existing.body.length) {
        existing.title = finding.title;
        existing.body = finding.body;
      }
      if (!existing.evidence && finding.evidence) existing.evidence = finding.evidence;
    }
  }

  const ranked = [...groups.values()].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    // Within a severity, a confident finding outranks a speculative one.
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.agreementCount - a.agreementCount;
  });

  const posted: TriagedFinding[] = [];
  const suppressed: TriagedFinding[] = [];

  for (const finding of ranked) {
    if (finding.confidence < minConfidence) {
      suppressed.push({
        ...finding,
        suppressedReason: `confidence ${finding.confidence.toFixed(2)} below threshold ${minConfidence}`,
      });
      continue;
    }
    if (posted.length >= maxInlineComments) {
      suppressed.push({
        ...finding,
        suppressedReason: `over the ${maxInlineComments}-comment cap`,
      });
      continue;
    }
    posted.push(finding);
  }

  return { posted, suppressed, summary: buildSummary(inputs, posted, suppressed) };
}

/**
 * Findings within a few lines of each other, in the same file and category, are treated
 * as the same defect — agents rarely anchor to the identical line.
 */
function dedupeKey(f: Finding): string {
  const bucket = f.lineStart ? Math.floor(f.lineStart / 10) : "none";
  return `${f.file ?? "repo"}:${f.category.toLowerCase()}:${bucket}`;
}

function buildSummary(
  inputs: AgentFindings[],
  posted: TriagedFinding[],
  suppressed: TriagedFinding[],
): string {
  const agentSummary = inputs.find((i) => i.summary)?.summary;
  if (!posted.length) {
    // A clean review is a real outcome and should read like one, not like a failure.
    return [
      agentSummary,
      `No issues met the reporting threshold. ${inputs.length} agent(s) reviewed this change` +
        (suppressed.length
          ? `; ${suppressed.length} low-confidence observation(s) were suppressed.`
          : "."),
    ]
      .filter(Boolean)
      .join(" ");
  }

  const counts = posted.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  const breakdown = ["critical", "high", "medium", "low", "info"]
    .filter((s) => counts[s])
    .map((s) => `${counts[s]} ${s}`)
    .join(", ");

  return [agentSummary, `${posted.length} finding(s) worth attention: ${breakdown}.`]
    .filter(Boolean)
    .join(" ");
}
