import type { PlaybookDocument } from "@maestro/playbook";
import picomatch from "picomatch";

export interface RouteInput {
  changedFiles: string[];
  changedLines: number;
  author?: string;
}

export interface RouteDecision {
  activeAgentIds: string[];
  skipped: { agentId: string; reason: string }[];
  costCapCents: number;
  /** Set when the whole review should be skipped, with the reason for the log. */
  skipReview?: string;
}

/**
 * Deterministic routing.
 *
 * Rules-first is the default because it means a fresh install needs no extra provider
 * key, routing decisions are inspectable in the UI, and this is unit-testable without a
 * model. An optional LLM refinement pass sits on top of it, never underneath.
 *
 * Routing is also the main lever on both cost and noise: not running the ui/ux agent on
 * a backend-only PR saves money AND avoids the generic comments that make people mute
 * an automated reviewer.
 */
export function route(doc: PlaybookDocument, input: RouteInput): RouteDecision {
  const { router } = doc;

  if (input.author && router.skipAuthors.includes(input.author)) {
    return {
      activeAgentIds: [],
      skipped: [],
      costCapCents: 0,
      skipReview: `author '${input.author}' is on the skip list`,
    };
  }

  if (router.skipIfOnlyPaths.length && input.changedFiles.length > 0) {
    const isIgnorable = picomatch(router.skipIfOnlyPaths, { dot: true });
    if (input.changedFiles.every((f) => isIgnorable(f))) {
      return {
        activeAgentIds: [],
        skipped: [],
        costCapCents: 0,
        skipReview: "every changed file matches skipIfOnlyPaths",
      };
    }
  }

  const activeAgentIds: string[] = [];
  const skipped: RouteDecision["skipped"] = [];

  for (const agent of doc.agents) {
    if (!agent.enabled) {
      skipped.push({ agentId: agent.id, reason: "disabled in playbook" });
      continue;
    }
    const rule = router.rules.find((r) => r.agentId === agent.id);
    if (!rule) {
      // No rule means no opinion, so the agent runs. Silently skipping an agent a user
      // added but forgot to write a rule for would be a confusing failure.
      activeAgentIds.push(agent.id);
      continue;
    }

    const included = picomatch(rule.include.length ? rule.include : ["**"], { dot: true });
    const excluded = rule.exclude.length ? picomatch(rule.exclude, { dot: true }) : () => false;
    const matches = input.changedFiles.filter((f) => included(f) && !excluded(f));

    if (matches.length) activeAgentIds.push(agent.id);
    else skipped.push({ agentId: agent.id, reason: "no changed file matches its path rules" });
  }

  // Budget tier from diff size: a two-line change should not be allowed to spend like
  // a two-thousand-line one.
  const tier =
    [...router.budgetTiers]
      .sort((a, b) => a.maxChangedLines - b.maxChangedLines)
      .find((t) => input.changedLines <= t.maxChangedLines) ??
    router.budgetTiers[router.budgetTiers.length - 1];

  return { activeAgentIds, skipped, costCapCents: tier?.costCapCents ?? 200 };
}
