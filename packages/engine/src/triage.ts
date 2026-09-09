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
  /**
   * Descriptions merged into this one that told a different story.
   *
   * Grouping by location alone means two genuinely different defects on the same line
   * can land in one group. Discarding the shorter body would lose the second defect, so
   * it is carried here and rendered under the main one: one comment per location, and
   * nothing an agent said is thrown away.
   */
  alsoReported?: { agentId: string; title: string; body: string }[];
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
  /** Who wrote the description currently leading each group — not who reported first. */
  const leadAgent = new Map<string, string>();

  for (const { agentId, findings } of inputs) {
    for (const finding of findings) {
      const candidates = dedupeKeys(finding);
      // The first candidate is this finding's own key; the rest are neighbours it may
      // join. Only join a neighbour that already exists — never create one.
      const key = candidates.find((k) => groups.has(k)) ?? candidates[0] ?? "repo:none";
      const existing = groups.get(key);

      if (!existing) {
        groups.set(key, { ...finding, agentIds: [agentId], agreementCount: 1 });
        leadAgent.set(key, agentId);
        continue;
      }

      // One agent reporting two defects in the same window is not agreement with
      // itself; keep them separate rather than inflating the agreement count.
      if (existing.agentIds.includes(agentId)) {
        const own = candidates[0] ?? key;
        if (!groups.has(own)) {
          groups.set(own, { ...finding, agentIds: [agentId], agreementCount: 1 });
          leadAgent.set(own, agentId);
          continue;
        }
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

      // Whichever explanation is fuller leads; the other is kept alongside it when it
      // is telling a different story rather than restating the same one.
      const incomingLeads = finding.body.length > existing.body.length;
      const other = incomingLeads
        ? { agentId: leadAgent.get(key) ?? agentId, ...existing }
        : { agentId, ...finding };

      if (incomingLeads) {
        existing.title = finding.title;
        existing.body = finding.body;
        existing.category = finding.category;
        leadAgent.set(key, agentId);
      }
      if (other.category !== existing.category) {
        const also = existing.alsoReported ?? [];
        also.push({ agentId: other.agentId, title: other.title, body: other.body });
        existing.alsoReported = also;
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

const BUCKET_LINES = 10;

/**
 * Candidate group keys for a finding, best match first.
 *
 * A shared LOCATION is the evidence that two agents found the same defect. Category is
 * not: agents invent their own slugs, so one defect arrives as `dead-conditional` from
 * one and `no-op-ternary` from another, and keying on category posted both — the
 * duplication that makes people stop reading an automated reviewer.
 *
 * But a finding with no line number carries no location evidence at all. Keying those on
 * file alone collapses every whole-PR observation into one group, scoring disagreement as
 * corroboration and demoting all but the longest to a footnote — over-merging, which is
 * the same failure wearing the other mask. So category comes back exactly where location
 * is missing, and nowhere else.
 *
 * Neighbouring buckets are candidates too: agents rarely anchor to the identical line,
 * and lines 78 and 80 straddle a bucket boundary that means nothing to a reader.
 */
function dedupeKeys(f: Finding): string[] {
  const file = f.file ?? "repo";
  if (!f.lineStart) return [`${file}:none:${f.category.toLowerCase()}`];

  const bucket = Math.floor(f.lineStart / BUCKET_LINES);
  return [`${file}:${bucket}`, `${file}:${bucket - 1}`, `${file}:${bucket + 1}`];
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
