/**
 * What can be true of a finding, in one place.
 *
 * These five strings were spelled out across four files and nowhere defined, and the
 * scattering has already caused a defect here: `unresolvedFindings` selected
 * `status='open'` while posting stamps every reported finding `'posted'`, so the carried
 * set was empty on every real review and a finding raised in one round silently vanished
 * from the next. Two files' notions of the same concept, one of them wrong, with nothing
 * to compare them against.
 */
export const FINDING_STATUSES = ["open", "posted", "accepted", "dismissed", "suppressed"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/**
 * Shown to a human and not yet judged.
 *
 * `posted` belongs here and its absence was the bug: a finding is stamped `posted` the
 * moment the comment goes up, which is exactly when it starts waiting for a verdict.
 */
export const STANDING_STATUSES = ["open", "posted"] as const;

/** A human has ruled on it. This is what the quality numbers are computed from. */
export const SETTLED_STATUSES = ["accepted", "dismissed"] as const;

/**
 * Never shown to anybody, so never counted for or against an agent.
 *
 * Derived, which guarantees every status lands in exactly one bucket — but derivation
 * alone does NOT force a decision about a new one: a sixth status would simply fall in
 * here, silently classified as "never shown", by default. The first version of this
 * comment claimed otherwise, and the mutation that should have proved it passed. The
 * membership is pinned in the test instead, so adding a status fails until somebody says
 * where it belongs.
 */
export const UNSHOWN_STATUSES = FINDING_STATUSES.filter(
  (s) =>
    !(STANDING_STATUSES as readonly string[]).includes(s) &&
    !(SETTLED_STATUSES as readonly string[]).includes(s),
);

/** `?,?` placeholders and the values, for an `IN (…)` clause. */
export function inClause(values: readonly string[]): { sql: string; params: string[] } {
  return { sql: values.map(() => "?").join(","), params: [...values] };
}
