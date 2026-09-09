import { logger, newId, type SqlDatabase } from "@maestro/core";
import type { GitHubClient, PullRequestRef } from "./github.js";

/**
 * Feedback ingestion.
 *
 * This is the only honest signal about whether Maestro's findings are worth reading.
 * Precision and recall cannot be computed when a comment is posted — they need a human
 * to react to it — so they are gathered here, after the fact, and shown in the UI rather
 * than promised in the comment itself.
 *
 * Three signals, in increasing order of reliability:
 *   thumbs up/down  — cheap, explicit, sparse
 *   thread resolved — a maintainer acted on it
 *   line changed    — the flagged code was actually edited afterwards, which is the
 *                     strongest evidence the finding landed
 */

export type FeedbackSignal = "thumbs_up" | "thumbs_down" | "resolved" | "line_changed";

export interface IngestResult {
  reviewId: string;
  recorded: number;
  accepted: number;
  dismissed: number;
}

function recordFeedback(
  db: SqlDatabase,
  findingId: string,
  signal: FeedbackSignal,
  actor?: string,
): void {
  // One signal per (finding, kind, actor): re-ingesting must not inflate the counts.
  const existing = db
    .prepare("SELECT id FROM feedback WHERE finding_id=? AND signal=? AND COALESCE(actor,'')=?")
    .get<{ id: string }>(findingId, signal, actor ?? "");
  if (existing) return;

  db.prepare(
    "INSERT INTO feedback (id, finding_id, signal, actor, created_at) VALUES (?,?,?,?,?)",
  ).run(
    newId("fd").replace("fd_", "fb_"),
    findingId,
    signal,
    actor ?? null,
    new Date().toISOString(),
  );
}

/**
 * Applies accumulated feedback to a finding's status.
 *
 * A single thumbs-down is enough to dismiss: the cost of keeping a rejected finding in
 * the precision numbers is higher than the cost of trusting one reviewer.
 */
function settleStatus(db: SqlDatabase, findingId: string): "accepted" | "dismissed" | "open" {
  const rows = db
    .prepare("SELECT signal FROM feedback WHERE finding_id=?")
    .all<{ signal: string }>(findingId)
    .map((r) => r.signal);

  const status = rows.includes("thumbs_down")
    ? "dismissed"
    : rows.some((s) => s === "thumbs_up" || s === "resolved" || s === "line_changed")
      ? "accepted"
      : "open";

  if (status !== "open") {
    // Dismissal is sticky: a later thumbs-up must not quietly revive a finding a
    // reviewer already rejected. Suppressed findings were never shown, so they are
    // never re-graded.
    db.prepare(
      `UPDATE findings SET status=? WHERE id=? AND status <> 'suppressed'
       AND NOT (status = 'dismissed' AND ? = 'accepted')`,
    ).run(status, findingId, status);
  }
  return status;
}

/**
 * Detects whether the code a finding pointed at was changed after the review.
 *
 * The strongest available signal, and the only one that needs no human action.
 */
export async function ingestLineChanges(
  db: SqlDatabase,
  client: GitHubClient,
  pr: PullRequestRef,
  reviewId: string,
): Promise<number> {
  const review = db
    .prepare("SELECT head_sha FROM reviews WHERE id=?")
    .get<{ head_sha: string }>(reviewId);
  if (!review) return 0;

  const current = await client.getPullRequest(pr).catch(() => null);
  if (!current || current.headSha === review.head_sha) return 0;

  // The DELTA since the review, not the pull request's cumulative file list. A finding
  // points at a file in the PR's diff by construction, so comparing against that list
  // answered "yes" for essentially every finding on the first push after any review —
  // marking them all accepted and driving every agent's acceptance rate to ~100%. The
  // metric the Quality view exists to show would have been meaningless, permanently,
  // because recordFeedback deduplicates.
  const changedSince = await client
    .filesChangedBetween(pr, review.head_sha, current.headSha)
    .catch(() => null);
  if (!changedSince) return 0;

  const findings = db
    .prepare(
      // 'posted' as well as 'open': posting stamps every reported finding 'posted',
      // so matching only 'open' made this a silent no-op on every real review.
      "SELECT id, file FROM findings WHERE review_id=? AND file IS NOT NULL AND status IN ('open','posted')",
    )
    .all<{ id: string; file: string }>(reviewId);

  let changed = 0;
  for (const finding of findings) {
    // File-level granularity: line-level would need the patch of every intermediate
    // commit, and touching the file at all since the review is meaningful evidence.
    if (changedSince.includes(finding.file)) {
      recordFeedback(db, finding.id, "line_changed");
      settleStatus(db, finding.id);
      changed++;
    }
  }
  if (changed) logger.info({ reviewId, changed }, "findings whose files were later edited");
  return changed;
}

/** Maps a GitHub reaction webhook to a feedback signal. */
export function signalFromReaction(content: string): FeedbackSignal | null {
  if (content === "+1" || content === "heart" || content === "hooray" || content === "rocket") {
    return "thumbs_up";
  }
  if (content === "-1" || content === "confused") return "thumbs_down";
  return null;
}

export function ingestReaction(
  db: SqlDatabase,
  commentId: number,
  reactionContent: string,
  actor?: string,
): IngestResult | null {
  const signal = signalFromReaction(reactionContent);
  if (!signal) return null;

  const findings = db
    .prepare("SELECT id, review_id FROM findings WHERE posted_comment_id=?")
    .all<{ id: string; review_id: string }>(String(commentId));
  if (!findings.length) return null;

  let accepted = 0;
  let dismissed = 0;
  for (const f of findings) {
    recordFeedback(db, f.id, signal, actor);
    const status = settleStatus(db, f.id);
    if (status === "accepted") accepted++;
    if (status === "dismissed") dismissed++;
  }

  return { reviewId: findings[0]?.review_id ?? "", recorded: findings.length, accepted, dismissed };
}

export interface AgentQuality {
  agentId: string;
  posted: number;
  accepted: number;
  dismissed: number;
  open: number;
  /** Undefined until there is any settled feedback: 0% and "no data" are different. */
  acceptanceRate?: number;
}

/**
 * Findings per agent and status, with cross-agent findings credited to each agent.
 *
 * `findings.agent_id` holds `agentIds.join(",")`, because triage merges what several
 * agents reported into one finding. Grouping on that column in SQL therefore invented an
 * agent called `security,architecture` and credited the finding to it — so exactly the
 * findings the design values most, the ones two agents independently raised, were the
 * ones missing from every per-agent number. Three places grouped this way; the split
 * happens here, once.
 */
export function findingCountsByAgent(
  db: SqlDatabase,
  opts: { includeSuppressed?: boolean } = {},
): { agentId: string; status: string; n: number }[] {
  const rows = db
    .prepare(
      `SELECT agent_id AS agentId, status, COUNT(*) AS n FROM findings
       ${opts.includeSuppressed ? "" : "WHERE status <> 'suppressed'"}
       GROUP BY agent_id, status`,
    )
    .all<{ agentId: string | null; status: string; n: number }>();

  const totals = new Map<string, number>();
  for (const row of rows) {
    // A finding with no agent recorded is still a finding; attributing it to "" would
    // silently drop it from the table it is supposed to appear in.
    const agents = (row.agentId ?? "unknown")
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    for (const agentId of agents.length ? agents : ["unknown"]) {
      const key = `${agentId}\u0000${row.status}`;
      totals.set(key, (totals.get(key) ?? 0) + row.n);
    }
  }
  return [...totals].map(([key, n]) => {
    const [agentId, status] = key.split("\u0000");
    return { agentId: agentId as string, status: status as string, n };
  });
}

/** Per-agent acceptance, which is what noise tuning should actually be driven by. */
export function agentQuality(db: SqlDatabase): AgentQuality[] {
  const rows = findingCountsByAgent(db);

  const byAgent = new Map<string, AgentQuality>();
  for (const row of rows) {
    const entry = byAgent.get(row.agentId) ?? {
      agentId: row.agentId,
      posted: 0,
      accepted: 0,
      dismissed: 0,
      open: 0,
    };
    entry.posted += row.n;
    if (row.status === "accepted") entry.accepted += row.n;
    else if (row.status === "dismissed") entry.dismissed += row.n;
    else entry.open += row.n;
    byAgent.set(row.agentId, entry);
  }

  return [...byAgent.values()].map((e) => {
    const settled = e.accepted + e.dismissed;
    return { ...e, acceptanceRate: settled ? e.accepted / settled : undefined };
  });
}
