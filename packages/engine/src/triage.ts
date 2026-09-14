import { type Finding, type Severity, severityRank } from "@maestro/agents";
import type { PlaybookDocument } from "@maestro/playbook";
import {
  applyProfile,
  type DeveloperCognitiveProfile,
  type Disposition,
  type ProfilePolicy,
  type Responses,
} from "@maestro/profile";
import type { CommandComparison } from "@maestro/sandbox";

export interface AgentFindings {
  agentId: string;
  findings: Finding[];
  summary?: string;
}

export interface TriagedFinding extends Finding {
  agentIds: string[];
  /**
   * Identifies the merge group this finding is.
   *
   * Assigned when the group is opened, so it is a record of what triage actually did.
   * The recorder previously recomputed a key as `file:category`, which stopped matching
   * the grouping rule the moment dedupe became proximity-based and category-independent:
   * two agents' different words for one defect got different groups, and two unrelated
   * defects of the same category in one file shared a group.
   */
  dedupeGroup: string;
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
  /**
   * What a developer profile decided about this finding, beside it and never in place of
   * it. Present only on a review run with a profile; see `@maestro/profile`'s policy.
   */
  personalization?: {
    disposition: Disposition;
    reason: string;
    sigma: number;
    effective: number;
    topic: string | null;
    followUp?: "tracked_ticket";
    /** Who made the disposition: the deterministic rules, or the triage agent within them. */
    source?: "rules" | "agent";
    /**
     * The triage agent's wording, when it passed the output guard. Beside `body`, never over
     * it: the agents' diagnosis is what gets stored and what eval scores.
     */
    body?: string;
  };
}

/** A developer profile a review is gated and worded for. */
export interface TriagePersonalization {
  subject: string;
  profile: DeveloperCognitiveProfile;
  policy?: ProfilePolicy;
  /** The answers the profile was scored from; the triage agent takes style exemplars from them. */
  responses?: Responses;
}

export interface TriageResult {
  posted: TriagedFinding[];
  suppressed: TriagedFinding[];
  summary: string;
  /** Present only when a profile was applied. */
  personalization?: {
    subject: string;
    batteryVersion: string;
    /** The state this developer would submit. Maestro itself still posts a comment. */
    state: "REQUEST_CHANGES" | "COMMENT";
    politenessTags: boolean;
    /** Cosmetic findings the profile left out of the comment. */
    dropped: number;
    /**
     * Whether the triage agent decided this review. Absent when none was asked; `unavailable`
     * when it could not run or answer, `rejected` when its answer broke the contract — both
     * leave the deterministic decision in place.
     */
    triageAgent?: { status: "used" | "unavailable" | "rejected"; note?: string };
  };
}

/** One ordering for the whole codebase; see severityRank's comment for why. */
const SEVERITY_RANK = (s: Severity): number => severityRank(s);

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
export function triage(
  doc: PlaybookDocument,
  inputs: AgentFindings[],
  comparisons?: CommandComparison[],
  personal?: TriagePersonalization,
): TriageResult {
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
        const group: TriagedFinding = {
          ...finding,
          agentIds: [agentId],
          dedupeGroup: `${finding.file ?? "repo"}@${finding.lineStart ?? "none"}#${groups.length}`,
          agreementCount: 1,
        };
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
      if (SEVERITY_RANK(finding.severity) < SEVERITY_RANK(existing.severity)) {
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
    const bySeverity = SEVERITY_RANK(a.severity) - SEVERITY_RANK(b.severity);
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

  if (!personal) {
    return { posted, suppressed, summary: buildSummary(inputs, posted, suppressed, comparisons) };
  }

  // Tier 3, after the mechanical gate and before the summary, so the summary counts what
  // the comment will actually carry. It sees only what triage would have posted: a finding
  // below the confidence threshold was never a candidate, whoever is reading.
  const gated = applyProfile(posted, personal.profile, personal.policy);
  const note = (a: (typeof gated.kept)[number]) => ({
    disposition: a.disposition,
    reason: a.reason,
    sigma: a.sigma,
    effective: a.effective,
    topic: a.topic,
    ...(a.followUp ? { followUp: a.followUp } : {}),
  });
  const kept = gated.kept.map((a) => ({ ...a.finding, personalization: note(a) }));
  for (const a of gated.dropped) {
    suppressed.push({
      ...a.finding,
      personalization: note(a),
      suppressedReason: `left out for ${personal.subject}: ${a.reason}`,
    });
  }
  return {
    posted: kept,
    suppressed,
    summary: buildSummary(inputs, kept, suppressed, comparisons),
    personalization: {
      subject: personal.subject,
      batteryVersion: personal.profile.batteryVersion,
      state: gated.state,
      politenessTags: personal.profile.useNegativePolitenessTags,
      dropped: gated.dropped.length,
    },
  };
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

/**
 * What the base-versus-head run established, in one sentence, deterministically.
 *
 * This says what was MEASURED. It deliberately does not try to decide which of the pull
 * request's claims a command bears on: that is a judgement about intent, triage runs no
 * model, and a regex hunting the description for "faster" would be exactly the kind of
 * guess that manufactures evidence. The agents read the description and the measurements
 * together and report a claim as unverified; this line makes sure the measurement itself
 * reaches the top of the comment either way.
 *
 * It lives in the summary rather than in a finding on purpose. A finding carries a
 * severity and passes through the confidence threshold and the inline-comment cap, so
 * "nothing here supports the claim" could be dropped for being low severity — which is
 * the one message that must not be silently discarded.
 */
export function comparisonNote(comparisons?: CommandComparison[]): string {
  if (!comparisons?.length) return "";

  const ran = comparisons.filter((c) => c.base && c.head);
  if (!ran.length) {
    const why = comparisons[0]?.skipped;
    return (
      "No command was compared against the merge base" +
      (why === "untrusted"
        ? " (fork pull requests execute no commands)"
        : why === "no-merge-base"
          ? " (the fork point could not be found)"
          : "") +
      ", so any claim in the description about being faster, smaller or fixing a failure " +
      "is unchecked here."
    );
  }

  const fixed = ran.filter((c) => c.verdict === "fixed").map((c) => c.command);
  const broken = ran.filter((c) => c.verdict === "broken").map((c) => c.command);
  const same = ran.filter((c) => c.verdict === "same-exit").map((c) => c.command);

  const parts: string[] = [];
  if (fixed.length)
    parts.push(`${fixed.join(", ")} fails at the merge base and passes at the head`);
  if (broken.length)
    parts.push(`${broken.join(", ")} passes at the merge base and fails at the head`);
  if (same.length) {
    parts.push(
      `${same.join(", ")} exits the same at both` +
        // The case a reader most needs spelled out: commands were run, and none of them
        // showed a change. Left implicit, a table of equal exit codes reads as support.
        (fixed.length || broken.length ? "" : ", so no measured behaviour changed"),
    );
  }
  return `Base vs head: ${parts.join("; ")}.`;
}

function buildSummary(
  inputs: AgentFindings[],
  posted: TriagedFinding[],
  suppressed: TriagedFinding[],
  comparisons?: CommandComparison[],
): string {
  const agentSummary = inputs.find((i) => i.summary)?.summary;
  const compared = comparisonNote(comparisons);
  if (!posted.length) {
    // A clean review is a real outcome and should read like one, not like a failure.
    return [
      agentSummary,
      `No issues met the reporting threshold. ${inputs.length} agent(s) reviewed this change` +
        (suppressed.length
          ? `; ${suppressed.length} low-confidence observation(s) were suppressed.`
          : "."),
      compared,
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

  return [agentSummary, `${posted.length} finding(s) worth attention: ${breakdown}.`, compared]
    .filter(Boolean)
    .join(" ");
}
