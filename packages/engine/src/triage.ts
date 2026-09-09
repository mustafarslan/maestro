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

  const groups: TriagedFinding[] = [];
  /** Who wrote the description currently leading each group — not who reported first. */
  const leadAgent = new Map<TriagedFinding, string>();

  for (const { agentId, findings } of inputs) {
    for (const finding of findings) {
      // One agent reporting twice in the same place is not agreement with itself, so a
      // group it already contributed to is not a candidate for it.
      const existing = groups.find((g) => sameDefect(g, finding) && !g.agentIds.includes(agentId));

      if (!existing) {
        const group: TriagedFinding = { ...finding, agentIds: [agentId], agreementCount: 1 };
        groups.push(group);
        leadAgent.set(group, agentId);
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

      // Whichever explanation is fuller leads; the other is kept alongside it when it
      // is telling a different story rather than restating the same one.
      const incomingLeads = finding.body.length > existing.body.length;
      const other = incomingLeads
        ? { agentId: leadAgent.get(existing) ?? agentId, ...existing }
        : { agentId, ...finding };

      if (incomingLeads) {
        existing.title = finding.title;
        existing.body = finding.body;
        existing.category = finding.category;
        leadAgent.set(existing, agentId);
      }
      if (other.category !== existing.category) {
        const also = existing.alsoReported ?? [];
        also.push({ agentId: other.agentId, title: other.title, body: other.body });
        existing.alsoReported = also;
      }
      if (!existing.evidence && finding.evidence) existing.evidence = finding.evidence;
    }
  }

  const ranked = [...groups].sort((a, b) => {
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
 * How far apart two reports of the same defect may be anchored.
 *
 * Agents rarely pick the identical line — one cites the `if`, another the return inside
 * it. Buckets were the first attempt and were wrong in both directions: they merged
 * findings 9 lines apart while splitting findings 2 lines apart across a boundary, and
 * which happened depended on where the code sat relative to a multiple of ten. An
 * explicit distance says what is actually meant and is symmetric.
 */
const MERGE_DISTANCE = 3;

/**
 * Whether two findings should be treated as one defect.
 *
 * A shared LOCATION is the evidence. Category is not: agents invent their own slugs, so
 * one defect arrives as `dead-conditional` from one and `no-op-ternary` from another,
 * and keying on category posted both — the duplication that makes people stop reading an
 * automated reviewer.
 *
 * A finding with no line number carries no location evidence at all, so category is the
 * only signal left and it decides. Without that, every whole-PR observation collapsed
 * into one group, scoring disagreement as corroboration — over-merging, the same failure
 * wearing the other mask.
 */
function sameDefect(a: Finding, b: Finding): boolean {
  if ((a.file ?? "repo") !== (b.file ?? "repo")) return false;

  if (!a.lineStart || !b.lineStart) {
    return !a.lineStart && !b.lineStart && a.category.toLowerCase() === b.category.toLowerCase();
  }
  return Math.abs(a.lineStart - b.lineStart) <= MERGE_DISTANCE;
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
