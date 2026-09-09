export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * How serious a severity is, as a number that sorts most-serious-first.
 *
 * There were six copies of this ordering across the codebase — two zod enums, three rank
 * maps and one array — and `eval.ts` spelled it backwards while everything else spelled it
 * forwards. Both were internally correct, which is what made it dangerous: the same word
 * meant opposite things in different files, and comparing with the wrong sense is a silent
 * inversion that accepts trivia and rejects real defects.
 *
 * It lives in `core` rather than in `agents` because two of those copies turned out to be
 * in SQL — `ORDER BY severity` on a TEXT column, which sorts alphabetically and puts
 * `medium` *below* `info` — in `core` and in the admin API, neither of which can import
 * from `agents`. A canonical value in a layer the callers cannot reach is not canonical.
 *
 * Anything unrecognised sorts last rather than first: an unknown severity should not be
 * treated as critical.
 */
export function severityRank(severity: string): number {
  const i = (SEVERITIES as readonly string[]).indexOf(severity);
  return i === -1 ? SEVERITIES.length : i;
}

/** True when `severity` is at least as serious as `floor`. */
export function severityAtLeast(severity: string, floor: string): boolean {
  return severityRank(severity) <= severityRank(floor);
}

/** Most serious first. The one ordering, for anything that presents findings. */
export function bySeverity<T extends { severity: string }>(a: T, b: T): number {
  return severityRank(a.severity) - severityRank(b.severity);
}
