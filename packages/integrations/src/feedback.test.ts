import { newId, openStore, ReviewStore, type SqlDatabase } from "@maestro/core";
import { beforeEach, describe, expect, it } from "vitest";
import { agentQuality, ingestReaction, signalFromReaction } from "./feedback.js";

let db: SqlDatabase;
let reviewId: string;

function seedFinding(agent = "security", commentId = 111, status = "open"): string {
  const id = newId("fd");
  db.prepare(
    `INSERT INTO findings (id, review_id, agent_id, file, line_start, category, severity,
                           confidence, title, body, posted_comment_id, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    reviewId,
    agent,
    "a.ts",
    1,
    "idor",
    "high",
    0.9,
    "t",
    "b",
    String(commentId),
    status,
    new Date().toISOString(),
  );
  return id;
}

beforeEach(async () => {
  db = await openStore({ path: ":memory:" });
  const pbId = newId("pb");
  const pvId = newId("pv");
  const now = new Date().toISOString();
  db.prepare("INSERT INTO playbooks (id, name, created_at, updated_at) VALUES (?,?,?,?)").run(
    pbId,
    "default",
    now,
    now,
  );
  db.prepare(
    "INSERT INTO playbook_versions (id, playbook_id, version, schema_version, document, created_at) VALUES (?,?,?,?,?,?)",
  ).run(pvId, pbId, 1, 1, "{}", now);
  reviewId = new ReviewStore(db).create({
    repoOwner: "acme",
    repoName: "web",
    prNumber: 1,
    headSha: "aaa",
    playbookVersionId: pvId,
  }).id;
});

describe("reaction mapping", () => {
  it("treats positive reactions as acceptance", () => {
    for (const c of ["+1", "heart", "hooray", "rocket"]) {
      expect(signalFromReaction(c), c).toBe("thumbs_up");
    }
  });

  it("treats negative reactions as dismissal", () => {
    expect(signalFromReaction("-1")).toBe("thumbs_down");
    expect(signalFromReaction("confused")).toBe("thumbs_down");
  });

  it("ignores reactions that carry no judgement", () => {
    expect(signalFromReaction("eyes")).toBeNull();
    expect(signalFromReaction("laugh")).toBeNull();
  });
});

describe("ingesting feedback", () => {
  it("marks a finding accepted on a thumbs up", () => {
    const id = seedFinding();
    const result = ingestReaction(db, 111, "+1", "alice");

    expect(result?.accepted).toBe(1);
    expect(
      db.prepare("SELECT status FROM findings WHERE id=?").get<{ status: string }>(id)?.status,
    ).toBe("accepted");
  });

  it("marks a finding dismissed on a thumbs down", () => {
    const id = seedFinding();
    ingestReaction(db, 111, "-1", "bob");
    expect(
      db.prepare("SELECT status FROM findings WHERE id=?").get<{ status: string }>(id)?.status,
    ).toBe("dismissed");
  });

  it("lets a dismissal outweigh an approval", () => {
    // Keeping a rejected finding in the precision numbers is more costly than trusting
    // the reviewer who rejected it.
    const id = seedFinding();
    ingestReaction(db, 111, "+1", "alice");
    ingestReaction(db, 111, "-1", "bob");
    expect(
      db.prepare("SELECT status FROM findings WHERE id=?").get<{ status: string }>(id)?.status,
    ).toBe("dismissed");
  });

  it("is idempotent, so re-ingesting a webhook cannot inflate the counts", () => {
    seedFinding();
    ingestReaction(db, 111, "+1", "alice");
    ingestReaction(db, 111, "+1", "alice");
    expect(db.prepare("SELECT COUNT(*) AS n FROM feedback").get<{ n: number }>()?.n).toBe(1);
  });

  it("records distinct reviewers separately", () => {
    seedFinding();
    ingestReaction(db, 111, "+1", "alice");
    ingestReaction(db, 111, "+1", "bob");
    expect(db.prepare("SELECT COUNT(*) AS n FROM feedback").get<{ n: number }>()?.n).toBe(2);
  });

  it("ignores a reaction on a comment Maestro did not post", () => {
    seedFinding("security", 111);
    expect(ingestReaction(db, 999, "+1")).toBeNull();
  });
});

describe("agent quality", () => {
  it("reports acceptance per agent, which is what noise tuning needs", () => {
    seedFinding("security", 201);
    seedFinding("ui-ux", 202);
    seedFinding("ui-ux", 203);
    ingestReaction(db, 201, "+1", "alice");
    ingestReaction(db, 202, "-1", "bob");
    ingestReaction(db, 203, "-1", "carol");

    const quality = Object.fromEntries(agentQuality(db).map((q) => [q.agentId, q]));
    expect(quality.security?.acceptanceRate).toBe(1);
    expect(quality["ui-ux"]?.acceptanceRate).toBe(0);
  });

  it("distinguishes 'no feedback yet' from 'zero percent'", () => {
    // Reporting an unrated agent as 0% would make a new agent look broken.
    seedFinding("architecture", 301);
    expect(
      agentQuality(db).find((q) => q.agentId === "architecture")?.acceptanceRate,
    ).toBeUndefined();
  });

  it("excludes suppressed findings, which were never shown to anyone", () => {
    seedFinding("security", 401, "suppressed");
    expect(agentQuality(db).find((q) => q.agentId === "security")).toBeUndefined();
  });
});

describe("dismissal is sticky", () => {
  it("does not let a later approval revive a dismissed finding", () => {
    const id = seedFinding();
    ingestReaction(db, 111, "-1", "bob");
    ingestReaction(db, 111, "+1", "alice");
    expect(
      db.prepare("SELECT status FROM findings WHERE id=?").get<{ status: string }>(id)?.status,
    ).toBe("dismissed");
  });

  it("never re-grades a suppressed finding, which nobody ever saw", () => {
    const id = seedFinding("security", 555, "suppressed");
    ingestReaction(db, 555, "+1", "alice");
    expect(
      db.prepare("SELECT status FROM findings WHERE id=?").get<{ status: string }>(id)?.status,
    ).toBe("suppressed");
  });
});
