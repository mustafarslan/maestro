import {
  type Budget,
  type LoopResult,
  type Provider,
  runAgent,
  type ToolDefinition,
} from "@maestro/llm";
import {
  buildTriageSystemPrompt,
  type PlaybookDocument,
  type PromptContext,
  wrapUntrusted,
} from "@maestro/playbook";
import {
  bundledBattery,
  COSMETIC_SIGMA,
  DEFAULT_PROFILE_POLICY,
  type Disposition,
  NON_SUPPRESSIBLE_SIGMA,
  type StyleExemplar,
  safeSubject,
  styleExemplars,
  styleGuide,
  synthesisProblems,
} from "@maestro/profile";
import type { CommandComparison } from "@maestro/sandbox";
import { z } from "zod";
import {
  comparisonNote,
  type TriagedFinding,
  type TriagePersonalization,
  type TriageResult,
} from "./triage.js";

/**
 * The triage agent: the step that reviews as the developer would.
 *
 * The specialists diagnose without a profile. Mechanical triage merges and gates what they
 * found. Then, only when a developer profile is active, one model call reads every surviving
 * finding and answers as that developer: which findings block, which are comments, nits or
 * notes, which cosmetic ones to leave out, a short summary, and each finding reworded in
 * their voice.
 *
 * The model is trusted with judgement and wording, never with facts:
 *
 *  - It refers to findings by an alias (F1, F2, ...) and never emits a diagnosis field, so
 *    file, line, title, body, severity and the merge group always come from the agents.
 *    Aliases also keep file paths — chosen by whoever opened the pull request — out of the
 *    trusted part of the prompt.
 *  - Its dispositions are clamped on the way out by the same invariants the rules enforce:
 *    σ ≥ 0.80 blocks, σ < 0.30 never does, only a cosmetic finding may be left out.
 *  - Each rewording passes `synthesisProblems` or is discarded, and the review state is
 *    recomputed from the clamped dispositions rather than taken from the model.
 *  - Anything that goes wrong — no provider, a quota error, prose instead of the tool, an
 *    answer for a finding it was not given — leaves the deterministic decision in place and
 *    says so. Never an empty review.
 */

export const TRIAGE_TOOL = "submit_review";
export const REVIEW_SUMMARY_MAX = 400;
export const REVIEW_BODY_MAX = 400;

const DISPOSITIONS = ["request_changes", "comment", "nit", "note", "drop"] as const;
const STATES = ["REQUEST_CHANGES", "COMMENT"] as const;

export const SubmitReviewSchema = z.object({
  state: z.enum(STATES),
  summary: z.string().trim().min(1).max(REVIEW_SUMMARY_MAX),
  findings: z
    .array(
      z.object({
        id: z.string().min(1).max(16),
        disposition: z.enum(DISPOSITIONS),
        body: z.string().trim().min(1).max(REVIEW_BODY_MAX),
      }),
    )
    .max(200),
});
export type SubmitReview = z.infer<typeof SubmitReviewSchema>;

export const SUBMIT_REVIEW_TOOL: ToolDefinition = {
  name: TRIAGE_TOOL,
  description: "Submit the final review and end triage. Call this exactly once.",
  inputSchema: {
    type: "object",
    properties: {
      state: { type: "string", enum: [...STATES] },
      summary: {
        type: "string",
        maxLength: REVIEW_SUMMARY_MAX,
        description: "One or two sentences: what the change does and whether it is safe to merge.",
      },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "The finding id exactly as given, e.g. F1." },
            disposition: { type: "string", enum: [...DISPOSITIONS] },
            body: {
              type: "string",
              maxLength: REVIEW_BODY_MAX,
              description: "At most two short sentences in the reviewer's voice: problem and fix.",
            },
          },
          required: ["id", "disposition", "body"],
          additionalProperties: false,
        },
      },
    },
    required: ["state", "summary", "findings"],
    additionalProperties: false,
  },
};

/**
 * What the triage agent decides about: everything mechanical triage would post, and what the
 * profile's rules left out. Never a finding below the confidence threshold or over the cap —
 * those were never candidates, whoever is reading.
 */
export function triageCandidates(t: TriageResult): TriagedFinding[] {
  return [...t.posted, ...t.suppressed.filter((f) => f.personalization?.disposition === "drop")];
}

const fmt = (x: number) => x.toFixed(2);

/** The reviewer, in words, for the system prompt. Built from the profile, never from the PR. */
export function profileBlock(personal: TriagePersonalization, exemplars: StyleExemplar[]): string {
  const p = personal.profile;
  const policy = personal.policy ?? DEFAULT_PROFILE_POLICY;
  const attr = (k: keyof typeof policy.fallbacks) => p.attributes[k] ?? policy.fallbacks[k];
  const blocking = attr("blocking_threshold");
  const pedantry = attr("pedantry_level");
  const debt = attr("technical_debt_tolerance");
  const observed = Object.entries(p.topicWeights).filter(
    ([t]) => (p.coverage.nPerTopic[t] ?? 0) > 0,
  );
  const heavy = observed.filter(([, w]) => w >= 0.66).map(([t]) => t.replaceAll("_", " "));
  const light = observed.filter(([, w]) => w <= 0.33).map(([t]) => t.replaceAll("_", " "));

  const lines = [
    `THE REVIEWER — you review as ${safeSubject(personal.subject)}, from their answers to a calibration questionnaire:`,
    `- Blocks a merge once a finding's weighted severity reaches ${fmt(blocking)} (0 blocks on anything, 1 almost never).`,
    `- Pedantry ${fmt(pedantry)}: ${
      pedantry < policy.pedantry.dropBelow
        ? "leaves cosmetic findings out"
        : pedantry < policy.pedantry.commentAtOrAbove
          ? "raises cosmetic findings as nits"
          : "raises cosmetic findings as comments"
    }.`,
    `- Tolerance for technical debt ${fmt(debt)}: ${
      debt >= policy.debt.trackedTicketMinTolerance
        ? "prefers a tracked follow-up to blocking on an architectural shortcut"
        : debt <= 0.33
          ? "blocks architectural shortcuts"
          : "weighs architectural shortcuts case by case"
    }.`,
    heavy.length ? `- Cares most about: ${heavy.join(", ")}.` : "",
    light.length ? `- Cares least about: ${light.join(", ")}.` : "",
    "",
    "HOW THEY WRITE:",
    ...styleGuide(p).directives.map((d) => `- ${d}`),
  ];
  if (exemplars.length) {
    lines.push(
      "",
      "COMMENTS THEY CHOSE AS THEIR OWN (from unrelated reviews: copy the tone, never the content):",
      ...exemplars.map((e) => wrapUntrusted(`exemplar-${e.itemId}`, e.comment)),
    );
  }
  return lines.filter((l, i, all) => l !== "" || (all[i - 1] ?? "") !== "").join("\n");
}

/**
 * The findings, each under an alias. The header line is computed by Maestro and trusted; the
 * finding's own words — including its category and file path — are fenced.
 */
export function triageUserPrompt(
  candidates: readonly TriagedFinding[],
  ctx: PromptContext = {},
): { prompt: string; aliases: Map<string, TriagedFinding> } {
  const aliases = new Map<string, TriagedFinding>();
  const parts: string[] = ["Decide the final review of this pull request."];
  if (ctx.pr?.title) parts.push(wrapUntrusted("pull-request-title", ctx.pr.title));

  if (!candidates.length) {
    parts.push("No findings survived mechanical triage. Say so in the summary; findings is empty.");
  }
  candidates.forEach((f, i) => {
    const alias = `F${i + 1}`;
    aliases.set(alias, f);
    const p = f.personalization;
    const marker = !p
      ? ""
      : p.sigma >= NON_SUPPRESSIBLE_SIGMA
        ? " · MUST BLOCK"
        : p.sigma < COSMETIC_SIGMA
          ? " · COSMETIC"
          : "";
    parts.push(
      `${alias} · ${f.severity}${p ? ` (σ ${fmt(p.sigma)}, weighted ${fmt(p.effective)})` : ""}` +
        ` · ${f.agreementCount} agent(s)${marker}${p ? ` · rules suggest: ${p.disposition}` : ""}`,
      wrapUntrusted(
        `finding-${alias}`,
        [
          `category: ${f.category}`,
          `where: ${f.file ? `${f.file}${f.lineStart ? `:${f.lineStart}` : ""}` : "whole pull request"}`,
          `title: ${f.title}`,
          `body: ${f.body}`,
          f.evidence ? `evidence: ${f.evidence.slice(0, 600)}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    );
  });
  if (candidates.length) {
    parts.push(
      `Call ${TRIAGE_TOOL} with one entry for each of: ${[...aliases.keys()].join(", ")}.`,
    );
  }
  return { prompt: parts.join("\n\n"), aliases };
}

export interface TriageAgentRequest {
  provider: Provider;
  model: string;
  doc: PlaybookDocument;
  /** Mechanical triage with the profile's rules applied. */
  triaged: TriageResult;
  personal: TriagePersonalization;
  context?: PromptContext;
  budget: Budget;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface TriageAgentRun {
  loop: LoopResult;
  prompts: { system: string; user: string };
  aliases: Map<string, TriagedFinding>;
  exemplars: StyleExemplar[];
  review?: SubmitReview;
  parseError?: string;
}

export async function runTriageAgent(req: TriageAgentRequest): Promise<TriageAgentRun> {
  const exemplars = req.personal.responses
    ? styleExemplars(bundledBattery(), req.personal.responses)
    : [];
  const system = buildTriageSystemPrompt(
    req.doc,
    req.context ?? {},
    profileBlock(req.personal, exemplars),
  );
  const { prompt, aliases } = triageUserPrompt(triageCandidates(req.triaged), req.context);

  const loop = await runAgent({
    provider: req.provider,
    model: req.model,
    system,
    prompt,
    tools: [SUBMIT_REVIEW_TOOL],
    terminalTool: TRIAGE_TOOL,
    // Triage has nothing to call but its terminal tool; anything else is refused, not run.
    dispatch: async (call) => ({
      output: `${call.name} is not available in triage. Call ${TRIAGE_TOOL}.`,
      isError: true,
    }),
    budget: req.budget,
    temperature: req.temperature,
    maxOutputTokens: req.maxOutputTokens,
    signal: req.signal,
  });

  const base = { loop, prompts: { system, user: prompt }, aliases, exemplars };
  if (loop.stopKind !== "terminal-tool") {
    return {
      ...base,
      parseError: `triage agent stopped with '${loop.stopKind}' before submitting`,
    };
  }
  const parsed = SubmitReviewSchema.safeParse(loop.terminalInput);
  if (!parsed.success) {
    return {
      ...base,
      parseError: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }
  return { ...base, review: parsed.data };
}

/** The invariants, applied to what the model chose. */
export function clampDisposition(proposed: Disposition, sigma: number): Disposition {
  if (sigma >= NON_SUPPRESSIBLE_SIGMA) return "request_changes";
  if (sigma < COSMETIC_SIGMA && proposed === "request_changes") return "comment";
  if (sigma >= COSMETIC_SIGMA && proposed === "drop") return "note";
  return proposed;
}

/** The deterministic result, marked with why the triage agent did not decide it. */
export function withTriageAgentStatus(
  t: TriageResult,
  status: "unavailable" | "rejected",
  note: string,
): TriageResult {
  if (!t.personalization) return t;
  return { ...t, personalization: { ...t.personalization, triageAgent: { status, note } } };
}

function countsSentence(posted: readonly TriagedFinding[]): string {
  if (!posted.length) return "No findings to raise.";
  const counts = posted.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  const breakdown = ["critical", "high", "medium", "low", "info"]
    .filter((s) => counts[s])
    .map((s) => `${counts[s]} ${s}`)
    .join(", ");
  return `${posted.length} finding(s): ${breakdown}.`;
}

export interface MergedTriage {
  triage: TriageResult;
  /** Every place Maestro overrode or discarded part of the agent's answer, for the log. */
  adjustments: string[];
}

/**
 * The agent's answer applied to the deterministic result, inside the invariants.
 */
export function mergeTriageReview(
  triaged: TriageResult,
  run: { review: SubmitReview; aliases: Map<string, TriagedFinding>; exemplars: StyleExemplar[] },
  personal: TriagePersonalization,
  comparisons?: CommandComparison[],
): MergedTriage {
  const adjustments: string[] = [];
  const unknown = run.review.findings.filter((x) => !run.aliases.has(x.id)).map((x) => x.id);
  if (unknown.length) {
    // An answer about findings it was never shown is not a review of this pull request.
    const note = `answered for findings it was not given (${unknown.join(", ")})`;
    return { triage: withTriageAgentStatus(triaged, "rejected", note), adjustments: [note] };
  }

  const aliasOf = new Map([...run.aliases].map(([alias, f]) => [f, alias]));
  const decided = new Map<TriagedFinding, SubmitReview["findings"][number]>();
  for (const answer of run.review.findings) {
    const f = run.aliases.get(answer.id) as TriagedFinding;
    if (decided.has(f)) adjustments.push(`${answer.id}: answered twice; the first answer stands`);
    else decided.set(f, answer);
  }

  const posted: TriagedFinding[] = [];
  const dropped: TriagedFinding[] = [];
  for (const f of triageCandidates(triaged)) {
    const alias = aliasOf.get(f) ?? "?";
    const base = f.personalization;
    const answer = decided.get(f);
    if (!base || !answer) {
      if (base && !answer) adjustments.push(`${alias}: no decision; the rules' decision stands`);
      (base?.disposition === "drop" ? dropped : posted).push(f);
      continue;
    }

    const disposition = clampDisposition(answer.disposition, base.sigma);
    if (disposition !== answer.disposition) {
      adjustments.push(
        `${alias}: ${answer.disposition} overridden to ${disposition} at σ ${fmt(base.sigma)}`,
      );
    }
    const bodyProblems = synthesisProblems(
      {
        finding: f,
        disposition,
        sigma: base.sigma,
        topic: base.topic,
        topicWeight: 0,
        architectural: false,
        effective: base.effective,
        reason: base.reason,
      },
      answer.body,
      run.exemplars,
    );
    if (bodyProblems.length) {
      adjustments.push(`${alias}: rewording discarded (${bodyProblems.join("; ")})`);
    }

    const next: TriagedFinding = {
      ...f,
      personalization: {
        ...base,
        disposition,
        source: "agent",
        ...(bodyProblems.length ? {} : { body: answer.body.trim() }),
      },
    };
    if (disposition === "drop") {
      dropped.push({
        ...next,
        suppressedReason: `left out for ${personal.subject}: the triage agent judged it cosmetic`,
      });
    } else {
      const { suppressedReason: _dropped, ...kept } = next;
      posted.push(kept);
    }
  }

  const state = posted.some((f) => f.personalization?.disposition === "request_changes")
    ? "REQUEST_CHANGES"
    : "COMMENT";
  if (state !== run.review.state) {
    adjustments.push(`state ${run.review.state} recomputed as ${state} from the dispositions`);
  }

  const summary = [run.review.summary.trim(), countsSentence(posted), comparisonNote(comparisons)]
    .filter(Boolean)
    .join(" ");

  return {
    triage: {
      posted,
      suppressed: [
        ...triaged.suppressed.filter((f) => f.personalization?.disposition !== "drop"),
        ...dropped,
      ],
      summary,
      personalization: {
        subject: personal.subject,
        batteryVersion: personal.profile.batteryVersion,
        politenessTags: personal.profile.useNegativePolitenessTags,
        state,
        dropped: dropped.length,
        triageAgent: adjustments.length
          ? { status: "used", note: `${adjustments.length} adjustment(s) by Maestro's rules` }
          : { status: "used" },
      },
    },
    adjustments,
  };
}
