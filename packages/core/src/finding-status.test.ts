import { describe, expect, it } from "vitest";
import {
  FINDING_STATUSES,
  inClause,
  SETTLED_STATUSES,
  STANDING_STATUSES,
  UNSHOWN_STATUSES,
} from "./finding-status.js";

describe("the finding status vocabulary", () => {
  // These five strings were spelled out across four files and nowhere defined, and the
  // scattering has already caused a defect here: `unresolvedFindings` matched only 'open'
  // while posting stamps every reported finding 'posted', so the carried set was empty on
  // every real review and a finding raised in one round vanished from the next.
  it("classifies every status exactly once", () => {
    const classified = [...STANDING_STATUSES, ...SETTLED_STATUSES, ...UNSHOWN_STATUSES];
    expect([...classified].sort()).toEqual([...FINDING_STATUSES].sort());
    expect(new Set(classified).size).toBe(classified.length);
  });

  it("does not let a new status default into 'never shown'", () => {
    // Deriving the third bucket guarantees exactly-once, and guarantees nothing about
    // intent: a sixth status falls in here silently and is then never counted for or
    // against any agent. Pinned, so adding one fails here until somebody classifies it.
    expect([...UNSHOWN_STATUSES]).toEqual(["suppressed"]);
  });

  it("counts a posted finding as still standing, which is the bug it replaces", () => {
    // A finding is stamped 'posted' the moment the comment goes up — which is exactly
    // when it starts waiting for a verdict, not when it stops.
    expect(STANDING_STATUSES).toContain("posted");
    expect(STANDING_STATUSES).toContain("open");
  });

  it("counts only human verdicts as settled", () => {
    // 'suppressed' must never appear here: it was never shown to anyone, so counting it
    // either way would make a quiet agent look accurate or a noisy one look wrong.
    expect([...SETTLED_STATUSES].sort()).toEqual(["accepted", "dismissed"]);
    expect(SETTLED_STATUSES).not.toContain("suppressed");
  });

  it("builds a placeholder list that matches its parameters", () => {
    // The two halves have to agree, and they did not the first time: placeholders were
    // added to a query without binding the values, which the suite caught.
    const { sql, params } = inClause(STANDING_STATUSES);
    expect(sql.split(",")).toHaveLength(params.length);
    expect(params).toEqual([...STANDING_STATUSES]);
  });
});
