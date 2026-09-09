import { newId, openStore, ReviewStore, type SqlDatabase } from "@maestro/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentQuality,
  ingestLineChanges,
  ingestReaction,
  pollCommentReactions,
  signalFromReaction,
} from "./feedback.js";

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
  db.prepare("UPDATE findings SET posted_comment_id=? WHERE id=?").run(String(commentId), id);
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

  it("credits a finding two agents raised to both of them", () => {
    // Triage merges what several agents reported into one row, and `agent_id` then holds
    // `"security,architecture"`. Grouping on that column in SQL invented an agent by that
    // name and credited the finding to it — so the findings the design values most, the
    // ones two agents independently found, were the ones missing from every per-agent
    // number, and cross-agent agreement corrupted exactly the signal it should improve.
    seedFinding("security,architecture", 501);
    ingestReaction(db, 501, "+1", "alice");

    const quality = Object.fromEntries(agentQuality(db).map((q) => [q.agentId, q]));
    expect(quality.security?.accepted).toBe(1);
    expect(quality.architecture?.accepted).toBe(1);
    expect(quality["security,architecture"]).toBeUndefined();
  });

  it("keeps a finding with no agent recorded rather than dropping it", () => {
    seedFinding("", 601);
    expect(agentQuality(db).find((q) => q.agentId === "unknown")?.posted).toBe(1);
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

describe("the line-change signal compares the right two things", () => {
  /** A finding pointing at a specific file, which is what this signal keys on. */
  const findingOn = (file: string): string => {
    const id = newId("fd");
    db.prepare(
      `INSERT INTO findings (id, review_id, agent_id, file, line_start, category, severity,
                             confidence, title, body, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      reviewId,
      "security",
      file,
      1,
      "idor",
      "high",
      0.9,
      "t",
      "b",
      "posted",
      new Date().toISOString(),
    );
    return id;
  };

  const statusOf = (id: string) =>
    db.prepare("SELECT status FROM findings WHERE id=?").get<{ status: string }>(id)?.status;

  const client = (since: string[] | null, prFiles: string[]) =>
    ({
      getPullRequest: async () => ({ headSha: "b".repeat(40), changedFiles: prFiles }),
      filesChangedBetween: async () => since,
    }) as unknown as Parameters<typeof ingestLineChanges>[1];

  const pr = { owner: "acme", repo: "web", number: 1 };

  it("does not settle a finding whose file has not changed since the review", async () => {
    // The bug this replaces: comparing against the pull request's cumulative file list
    // answered "yes" for essentially every finding, because a finding points at a file in
    // that diff by construction. Every agent's acceptance rate went to ~100% and stayed
    // there, because recordFeedback deduplicates.
    const id = findingOn("src/untouched.ts");
    const settled = await ingestLineChanges(
      db,
      client(["src/other.ts"], ["src/untouched.ts", "src/other.ts"]),
      pr,
      reviewId,
    );
    expect(settled).toBe(0);
    expect(statusOf(id)).toBe("posted");
  });

  it("settles a finding whose file was edited after the review", async () => {
    const id = findingOn("src/fixed.ts");
    const settled = await ingestLineChanges(
      db,
      client(["src/fixed.ts"], ["src/fixed.ts"]),
      pr,
      reviewId,
    );
    expect(settled).toBe(1);
    expect(statusOf(id)).toBe("accepted");
  });

  it("settles nothing when the delta cannot be determined", async () => {
    // Unknown is not "nothing changed"; settling on a failed comparison would record a
    // verdict nobody reached.
    const id = findingOn("src/fixed.ts");
    const settled = await ingestLineChanges(db, client(null, ["src/fixed.ts"]), pr, reviewId);
    expect(settled).toBe(0);
    expect(statusOf(id)).toBe("posted");
  });
});

describe("reactions are polled, because no webhook delivers them", () => {
  // GitHub's event catalogue has no `reaction` event — this project's own App manifest
  // requests pull_request, issue_comment and pull_request_review_comment because those
  // are the ones that exist — so the daemon's handler for one could never fire and the
  // reaction half of the quality signal was built, tested and unreachable.
  const client = (reactions: { content: string; login?: string }[]) => ({
    calls: 0,
    async listCommentReactions() {
      this.calls++;
      return reactions;
    },
  });

  it("records a verdict left on a comment Maestro posted", async () => {
    seedFinding("security", 701);
    const c = client([{ content: "+1", login: "alice" }]);
    const result = await pollCommentReactions(db, c);
    expect(result).toMatchObject({ comments: 1, recorded: 1 });
    expect(agentQuality(db).find((q) => q.agentId === "security")?.accepted).toBe(1);
  });

  it("counts each person once however often it sweeps", async () => {
    // The sweep runs every ten minutes for a fortnight. Without idempotency one 👍 would
    // become two thousand, and the acceptance rate would be whatever the polling interval
    // happened to be.
    seedFinding("security", 702);
    const c = client([{ content: "+1", login: "alice" }]);
    await pollCommentReactions(db, c);
    await pollCommentReactions(db, c);
    await pollCommentReactions(db, c);
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM feedback").get<{ n: number }>() as {
      n: number;
    };
    expect(n).toBe(1);
  });

  it("counts two people separately", async () => {
    seedFinding("security", 703);
    const c = client([
      { content: "+1", login: "alice" },
      { content: "-1", login: "bob" },
    ]);
    await pollCommentReactions(db, c);
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM feedback").get<{ n: number }>() as {
      n: number;
    };
    expect(n).toBe(2);
  });

  it("ignores reactions that carry no verdict", async () => {
    // 👀 means somebody is looking, not that the finding was right or wrong. (`rocket`
    // is not this case — `signalFromReaction` deliberately counts it as approval, which
    // I had to read rather than assume.)
    seedFinding("security", 704);
    await pollCommentReactions(db, client([{ content: "eyes", login: "alice" }]));
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM feedback").get<{ n: number }>() as {
      n: number;
    };
    expect(n).toBe(0);
  });

  it("keeps sweeping when one comment cannot be read", async () => {
    // A deleted comment, or a repository the credential lost access to, is ordinary and
    // must not stop the other comments being swept.
    seedFinding("security", 705);
    const failing = {
      async listCommentReactions() {
        throw new Error("410 Gone");
      },
    };
    await expect(pollCommentReactions(db, failing)).resolves.toMatchObject({ recorded: 0 });
  });

  it("does not ask about comments from reviews older than the window", async () => {
    seedFinding("security", 706);
    db.prepare("UPDATE reviews SET created_at=?, finished_at=?").run(
      new Date(Date.now() - 60 * 24 * 60 * 60_000).toISOString(),
      new Date(Date.now() - 60 * 24 * 60 * 60_000).toISOString(),
    );
    const c = client([{ content: "+1", login: "alice" }]);
    expect(await pollCommentReactions(db, c)).toMatchObject({ comments: 0 });
    expect(c.calls).toBe(0);
  });
});
