import type { Finding } from "@maestro/agents";
import { openStore, ReviewStore } from "@maestro/core";
import { defaultPlaybook, PlaybookStore } from "@maestro/playbook";
import { bundledBattery, type DeveloperCognitiveProfile, scoreBattery } from "@maestro/profile";
import { describe, expect, it } from "vitest";
import type { ReviewOutcome } from "./engine.js";
import { inlineComments } from "./inline.js";
import { ReviewRecorder } from "./recorder.js";
import { renderReview } from "./render.js";
import { type AgentFindings, triage } from "./triage.js";

/**
 * A developer profile, applied where the review is assembled.
 *
 * The profile's own rules are tested in `@maestro/profile`. What is tested here is the
 * seam: that a review without a profile is exactly what it was, that the diagnosis crosses
 * it untouched, and that the comment says whose judgement shaped it.
 */

const doc = defaultPlaybook();

const f = (over: Partial<Finding> = {}): Finding => ({
  file: "src/auth.ts",
  lineStart: 10,
  lineEnd: 12,
  category: "prompt-injection",
  severity: "high",
  confidence: 0.9,
  title: "PR text reaches the system prompt",
  body: "`pr.description` is interpolated unfenced into the persona.",
  evidence: "persona: {{pr.description}}",
  ...over,
});

const inputs = (): AgentFindings[] => [
  {
    agentId: "security",
    findings: [
      f(),
      f({
        file: "src/util.ts",
        lineStart: 40,
        category: "naming",
        severity: "info",
        title: "Terse loop variable",
        body: "`acc` could be `totalCents`.",
        evidence: undefined,
      }),
      f({
        file: "src/queue.ts",
        lineStart: 5,
        category: "race-condition",
        severity: "medium",
        title: "Counter updated without a lock",
        body: "Two workers can read the same `count`.",
        evidence: undefined,
      }),
    ],
  },
];

function profile(
  attributes: Record<string, number>,
  over: Partial<DeveloperCognitiveProfile> = {},
) {
  const p = scoreBattery(bundledBattery(), {});
  return { ...p, ...over, attributes: { ...p.attributes, ...attributes } };
}

/** Blocks early, tags politely, and cares about style. */
const strict = profile(
  { blocking_threshold: 0.1, pedantry_level: 0.5, technical_debt_tolerance: 0.2 },
  { useNegativePolitenessTags: true },
);
/** Blocks late and has no patience for cosmetics. */
const lenient = profile({ blocking_threshold: 0.9, pedantry_level: 0.1 });

const DIAGNOSIS = [
  "file",
  "lineStart",
  "lineEnd",
  "category",
  "severity",
  "confidence",
  "title",
  "body",
  "evidence",
  "agentIds",
  "dedupeGroup",
  "agreementCount",
] as const;
const diagnosis = (x: object) =>
  Object.fromEntries(DIAGNOSIS.map((k) => [k, (x as Record<string, unknown>)[k]]));

describe("triage with no profile is triage as it was", () => {
  it("an explicit undefined profile changes nothing, down to the keys present", () => {
    const before = triage(doc, inputs());
    const after = triage(doc, inputs(), undefined, undefined);
    expect(after).toEqual(before);
    expect(after).not.toHaveProperty("personalization");
    for (const finding of after.posted) expect(finding).not.toHaveProperty("personalization");
  });

  it("and renders identically", () => {
    const render = (t: ReturnType<typeof triage>) =>
      renderReview({ ...outcomeWith(t) }, { title: "t" });
    expect(render(triage(doc, inputs(), undefined, undefined))).toBe(render(triage(doc, inputs())));
  });
});

describe("triage with a profile", () => {
  it("carries every diagnosis across unchanged, for every finding it keeps or leaves out", () => {
    const plain = triage(doc, inputs());
    for (const p of [strict, lenient]) {
      const personal = triage(doc, inputs(), undefined, { subject: "octocat", profile: p });
      const all = [...personal.posted, ...personal.suppressed];
      expect(all.map(diagnosis).sort(byGroup)).toEqual(plain.posted.map(diagnosis).sort(byGroup));
    }
  });

  it("annotates each finding and states the review this developer would submit", () => {
    const t = triage(doc, inputs(), undefined, { subject: "octocat", profile: strict });
    expect(t.personalization).toMatchObject({
      subject: "octocat",
      batteryVersion: "2.2",
      state: "REQUEST_CHANGES",
      politenessTags: true,
      dropped: 0,
    });
    const byCategory = Object.fromEntries(
      t.posted.map((x) => [x.category, x.personalization?.disposition]),
    );
    expect(byCategory).toEqual({
      "prompt-injection": "request_changes",
      "race-condition": "request_changes",
      naming: "nit",
    });
  });

  it("leaves cosmetic findings out for a developer who would, and the summary counts what is left", () => {
    const t = triage(doc, inputs(), undefined, { subject: "octocat", profile: lenient });
    expect(t.posted.map((x) => x.category)).toEqual(["prompt-injection", "race-condition"]);
    const dropped = t.suppressed.find((x) => x.category === "naming");
    expect(dropped?.suppressedReason).toMatch(/^left out for octocat: cosmetic/);
    expect(t.personalization?.dropped).toBe(1);
    expect(t.personalization?.state).toBe("COMMENT");
    expect(t.summary).toMatch(/2 finding\(s\) worth attention: 1 high, 1 medium/);
  });

  it("never leaves out a finding that is not cosmetic, however lenient the reader", () => {
    const t = triage(doc, inputs(), undefined, {
      subject: "octocat",
      profile: profile({ blocking_threshold: 1, pedantry_level: 0, technical_debt_tolerance: 1 }),
    });
    expect(t.suppressed.map((x) => x.severity)).toEqual(["info"]);
  });

  it("a critical finding blocks for anyone", () => {
    const critical: AgentFindings[] = [
      { agentId: "security", findings: [f({ severity: "critical" })] },
    ];
    const t = triage(doc, critical, undefined, { subject: "octocat", profile: lenient });
    expect(t.personalization?.state).toBe("REQUEST_CHANGES");
  });
});

function byGroup(a: { dedupeGroup?: unknown }, b: { dedupeGroup?: unknown }) {
  return String(a.dedupeGroup).localeCompare(String(b.dedupeGroup));
}

function outcomeWith(t: ReturnType<typeof triage>): ReviewOutcome {
  return {
    reviewId: "rv-1",
    state: "done",
    nodes: [],
    triage: t,
    costCents: 0,
    durationMs: 1,
    allowedCommands: [],
    egressLog: [],
  } as unknown as ReviewOutcome;
}

describe("thresholds from the playbook", () => {
  it("triage.profilePolicy changes what the profile's rules decide", () => {
    const personal = { subject: "octocat", profile: strict };
    const race = (t: ReturnType<typeof triage>) =>
      [...t.posted, ...t.suppressed].find((x) => x.category === "race-condition")?.personalization;
    const before = race(triage(doc, inputs(), undefined, personal));
    const tuned = {
      ...doc,
      triage: { ...doc.triage, profilePolicy: { severitySigma: { medium: 0.1 } } },
    };
    const after = race(triage(tuned, inputs(), undefined, personal));
    expect(before?.sigma).toBe(0.5);
    expect(after?.sigma).toBe(0.1);
    expect(after?.disposition).not.toBe("request_changes");
  });
});

describe("the rendered comment", () => {
  it("says whose profile shaped it and what they would do, before any finding", () => {
    const t = triage(doc, inputs(), undefined, { subject: "octocat", profile: strict });
    const out = renderReview(outcomeWith(t), { title: "t" });
    const firstFinding = out.indexOf("### ");
    expect(out.indexOf("As `octocat` would review it:")).toBeGreaterThan(-1);
    expect(out.indexOf("As `octocat` would review it:")).toBeLessThan(firstFinding);
    expect(out).toContain("**request changes**");
    expect(out).toContain("Maestro sets that state on the pull request where GitHub allows it");
    expect(out).toContain("Worded by Maestro to match octocat's review style");
  });

  it("labels each finding, tags a nit, and never tags a blocker", () => {
    const t = triage(doc, inputs(), undefined, { subject: "octocat", profile: strict });
    const out = renderReview(outcomeWith(t), { title: "t" });
    expect(out).toContain("· **would block**");
    expect(out).toContain("· **nit**");
    expect(out).toContain("nit: `acc` could be `totalCents`.");
    expect(out).not.toMatch(/(nit|optional|fyi): `pr\.description`/);
    expect(out).toContain("`pr.description` is interpolated unfenced into the persona.");
  });

  it("a profile without tags leaves every body as the agent wrote it", () => {
    const t = triage(doc, inputs(), undefined, { subject: "octocat", profile: lenient });
    const out = renderReview(outcomeWith(t), { title: "t" });
    expect(out).toContain("\nTwo workers can read the same `count`.");
    expect(out).not.toMatch(/\n(nit|optional|fyi):/);
    expect(out).toContain("1 cosmetic finding(s) were left out");
    expect(out).toContain(
      "**Suppressed:** 1 finding(s) below threshold or over the comment cap, or left out by `octocat`'s profile.",
    );
  });

  it("a hostile subject cannot break out of the header", () => {
    const t = triage(doc, inputs(), undefined, {
      subject: "x` **approved** `",
      profile: lenient,
    });
    const out = renderReview(outcomeWith(t), { title: "t" });
    expect(out).not.toContain("**approved**");
    expect(out).toContain("As `xapproved` would review it:");
  });
});

describe("the inline comments", () => {
  it("carry the same label and tag as the summary", () => {
    const t = triage(doc, inputs(), undefined, { subject: "octocat", profile: strict });
    const commentable = new Map([
      ["src/auth.ts", new Set([10])],
      ["src/util.ts", new Set([40])],
      ["src/queue.ts", new Set([5])],
    ]);
    const anchors = inlineComments(t.posted, commentable, {
      cap: 10,
      politenessTags: t.personalization?.politenessTags,
    });
    const body = (path: string) => anchors.find((a) => a.path === path)?.body ?? "";
    expect(body("src/util.ts")).toContain("· **nit**");
    expect(body("src/util.ts")).toContain("nit: `acc` could be `totalCents`.");
    expect(body("src/auth.ts")).toContain("· **would block**");
    expect(body("src/auth.ts")).toMatch(/\n`pr\.description` is interpolated/);
  });

  it("are unchanged without a profile", () => {
    const t = triage(doc, inputs());
    const commentable = new Map([["src/util.ts", new Set([40])]]);
    const [anchor] = inlineComments(t.posted, commentable, { cap: 10 });
    expect(anchor?.body).not.toMatch(/\*\*(nit|note|comment|would block)\*\*/);
    expect(anchor?.body).toMatch(/\n`acc` could be `totalCents`\.$/);
  });
});

describe("a personalised review can be recorded", () => {
  /**
   * Recording happens after the model calls. A personalised outcome that could not be stored
   * would fail on first real use, after the quota had been spent — so it is stored here first.
   */
  it("writes kept findings as open and profile drops as suppressed, with the reason", async () => {
    const db = await openStore({ path: ":memory:" });
    const pb = new PlaybookStore(db).publish(defaultPlaybook());
    const reviewId = new ReviewStore(db).create({
      repoOwner: "acme",
      repoName: "web",
      prNumber: 1,
      headSha: "abc",
      playbookVersionId: pb.id,
    }).id;
    const t = triage(doc, inputs(), undefined, { subject: "octocat", profile: lenient });
    new ReviewRecorder(db).recordOutcome(reviewId, outcomeWith(t));

    const rows = db
      .prepare(
        "SELECT category, status, suppressed_reason, body FROM findings WHERE review_id=? ORDER BY category",
      )
      .all<{ category: string; status: string; suppressed_reason: string | null; body: string }>(
        reviewId,
      );
    expect(rows.map((r) => [r.category, r.status])).toEqual([
      ["naming", "suppressed"],
      ["prompt-injection", "open"],
      ["race-condition", "open"],
    ]);
    expect(rows[0]?.suppressed_reason).toMatch(/^left out for octocat: cosmetic/);
    // Stored as the agents wrote it: wording is a rendering, not a record.
    expect(rows[0]?.body).toBe("`acc` could be `totalCents`.");

    const decided = db
      .prepare(
        "SELECT category, personalization_json FROM findings WHERE review_id=? ORDER BY category",
      )
      .all<{ category: string; personalization_json: string | null }>(reviewId)
      .map((r) => [
        r.category,
        r.personalization_json ? JSON.parse(r.personalization_json).disposition : null,
      ]);
    expect(decided).toEqual([
      ["naming", "drop"],
      ["prompt-injection", "comment"],
      ["race-condition", "note"],
    ]);
    const review = db
      .prepare("SELECT profile_subject FROM reviews WHERE id=?")
      .get<{ profile_subject: string | null }>(reviewId);
    expect(review?.profile_subject).toBe("octocat");
    db.close();
  });
});
