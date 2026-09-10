import { newId, openStore, ReviewStore, type SqlDatabase, unresolvedFindings } from "@maestro/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentQuality,
  ingestLineChanges,
  ingestReaction,
  lineChangedByAgent,
  pollCommentReactions,
  recordDismissal,
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

  it("records the signal for a finding whose file was edited, without settling it", async () => {
    // The signal is file-level: touching the file cannot mean this particular defect was
    // addressed. It used to settle the finding as `accepted`, which is outside
    // STANDING_STATUSES — so one push dropped every finding in that file out of the
    // standing set and carry-forward returned nothing on the next round. Measured on a
    // live pull request: four findings, one push, four duplicate inline comments.
    const id = findingOn("src/fixed.ts");
    const settled = await ingestLineChanges(
      db,
      client(["src/fixed.ts"], ["src/fixed.ts"]),
      pr,
      reviewId,
    );
    expect(settled).toBe(1);
    expect(statusOf(id)).toBe("posted");

    // The evidence is kept; it is reported rather than treated as a verdict.
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM feedback WHERE finding_id=? AND signal='line_changed'")
        .get<{ n: number }>(id)?.n,
    ).toBe(1);
    expect(lineChangedByAgent(db).reduce((n, r) => n + r.n, 0)).toBe(1);
  });

  it("keeps such a finding available to carry forward", async () => {
    // The whole point: the next review must still see it. `unresolvedFindings` selects
    // STANDING_STATUSES, and `accepted` is not one of them.
    const id = findingOn("src/fixed.ts");
    await ingestLineChanges(db, client(["src/fixed.ts"], ["src/fixed.ts"]), pr, reviewId);
    expect(unresolvedFindings(db, reviewId).map((f) => f.file)).toContain("src/fixed.ts");
    expect(statusOf(id)).not.toBe("accepted");
  });

  it("still settles on an explicit human verdict", async () => {
    // A person saying so is a verdict; a file changing is not. Without this, the change
    // above would read as "settling was removed" rather than "one weak signal stopped
    // counting as a verdict".
    const id = findingOn("src/judged.ts");
    db.prepare("UPDATE findings SET posted_comment_id='9' WHERE id=?").run(id);
    ingestReaction(db, 9, "+1", "someone");
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

  it("never makes more requests in one sweep than its cap", async () => {
    // One request per comment per sweep, every ten minutes, for ever. Unbounded that is
    // 1200 requests an hour at 200 comments and 6000 at a thousand — and GitHub allows
    // 5000. The measurement would have starved the reviews it exists to measure, on
    // exactly the busy repository where the numbers matter most.
    for (let i = 0; i < 30; i++) seedFinding("security", 900 + i);
    const c = client([{ content: "+1", login: "alice" }]);

    const result = await pollCommentReactions(db, c, { maxComments: 5 });

    expect(result.comments).toBe(5);
    expect(c.calls).toBe(5);
  });

  it("spends its budget on the newest comments, where the reactions are", async () => {
    // A reaction almost always arrives while the pull request is still being looked at.
    // An old comment falling out of the sweep loses a rare late reaction; the alternative
    // failure is exhausting the rate limit, which loses everything.
    const old = seedFinding("security", 801);
    db.prepare("UPDATE reviews SET finished_at=?").run(
      new Date(Date.now() - 10 * 24 * 60 * 60_000).toISOString(),
    );
    const pv = db.prepare("SELECT id FROM playbook_versions LIMIT 1").get<{ id: string }>();
    const recentReview = new ReviewStore(db).create({
      repoOwner: "acme",
      repoName: "web",
      prNumber: 99,
      headSha: "recent",
      playbookVersionId: pv?.id as string,
    });
    db.prepare(
      `INSERT INTO findings (id, review_id, agent_id, category, severity, confidence, title,
                             body, posted_comment_id, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      newId("fd"),
      recentReview.id,
      "security",
      "c",
      "high",
      0.9,
      "t",
      "b",
      "802",
      "open",
      new Date().toISOString(),
    );
    db.prepare("UPDATE reviews SET finished_at=? WHERE id=?").run(
      new Date().toISOString(),
      recentReview.id,
    );

    const asked: number[] = [];
    const c = {
      async listCommentReactions(_pr: unknown, id: number) {
        asked.push(id);
        return [];
      },
    };
    await pollCommentReactions(db, c, { maxComments: 1 });

    expect(asked).toEqual([802]);
    expect(old).toBeTruthy();
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

describe("a reaction belongs to one comment, not to a whole review", () => {
  /** Same numeric id on both kinds, which is the ordinary case: separate sequences. */
  function seedKinded(kind: "summary" | "inline", commentId: number): string {
    const id = seedFinding("security", commentId);
    db.prepare("UPDATE findings SET posted_comment_kind=? WHERE id=?").run(kind, id);
    return id;
  }

  it("does not carry a summary reaction onto a review comment with the same id", () => {
    // Issue comments and review comments are drawn from independent sequences, so a
    // summary comment's id is usually also a valid review-comment id. Matching on the id
    // alone would settle a finding nobody reacted to.
    const summaryFinding = seedKinded("summary", 4242);
    const inlineFinding = seedKinded("inline", 4242);

    ingestReaction(db, 4242, "-1", "ada", "summary");

    const statusOf = (id: string) =>
      db.prepare("SELECT status FROM findings WHERE id=?").get<{ status: string }>(id)?.status;
    expect(statusOf(summaryFinding)).toBe("dismissed");
    expect(statusOf(inlineFinding)).toBe("open");
  });

  it("reads a row written before the column existed as a summary comment", () => {
    // Every id written before the kind was stored was a summary comment's, so that is
    // what NULL means. Treating it as unknown would drop the entire existing history.
    const id = seedFinding("security", 99);
    expect(
      db.prepare("SELECT posted_comment_kind AS k FROM findings WHERE id=?").get<{
        k: string | null;
      }>(id)?.k,
    ).toBeNull();

    ingestReaction(db, 99, "-1", "ada");
    expect(
      db.prepare("SELECT status FROM findings WHERE id=?").get<{ status: string }>(id)?.status,
    ).toBe("dismissed");
  });
});

describe("a dismissal typed by a person", () => {
  it("records the feedback row as well as the status", () => {
    const id = seedFinding();
    expect(recordDismissal(db, id, { reason: "not real", actor: "ada" })).toBe(true);

    const rows = db
      .prepare("SELECT signal, actor FROM feedback WHERE finding_id=?")
      .all<{ signal: string; actor: string }>(id);
    expect(rows).toEqual([{ signal: "thumbs_down", actor: "ada" }]);
    expect(
      db
        .prepare("SELECT status, suppressed_reason AS why FROM findings WHERE id=?")
        .get<{ status: string; why: string }>(id),
    ).toEqual({ status: "dismissed", why: "not real" });
  });

  it("says so rather than reporting a dismissal that landed nowhere", () => {
    expect(recordDismissal(db, "fd_does_not_exist")).toBe(false);
  });
});
