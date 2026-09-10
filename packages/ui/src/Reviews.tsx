import { useEffect, useState } from "react";
import { api, type FindingRow, type ReviewDetail, type ReviewRow, type TaskRow } from "./api";

function relative(iso: string | null): string {
  if (!iso) return "—";
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 60) return `${Math.floor(secs)}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/** Cost is unknown, not zero, when the provider has no pricing data. */
function cost(cents: number): string {
  return cents > 0 ? `${cents.toFixed(2)}¢` : "—";
}

function taskOutput(t: TaskRow): { model?: string; stopKind?: string; findings?: number } {
  try {
    return t.output_json ? JSON.parse(t.output_json) : {};
  } catch {
    return {};
  }
}

/**
 * Span waterfall.
 *
 * Bars are positioned against the review's own wall-clock window, so overlapping bars
 * are the visual proof that agents really ran in parallel rather than in sequence.
 */
function Waterfall({ tasks, highlight }: { tasks: TaskRow[]; highlight?: string | null }) {
  const timed = tasks.filter((t) => t.created_at);
  if (!timed.length) return <div className="empty">no tasks recorded</div>;

  const starts = timed.map((t) => new Date(t.created_at).getTime());
  const ends = timed.map((t) => new Date(t.finished_at ?? t.created_at).getTime());
  const t0 = Math.min(...starts);
  const t1 = Math.max(...ends, t0 + 1);
  const span = t1 - t0;

  return (
    <div className="waterfall">
      {timed.map((t) => {
        const start = new Date(t.created_at).getTime();
        const end = new Date(t.finished_at ?? t.created_at).getTime();
        const left = ((start - t0) / span) * 100;
        const width = Math.max(((end - start) / span) * 100, 0.6);
        const out = taskOutput(t);
        return (
          <div
            className={`wf-row${t.id === highlight ? " wf-highlight" : ""}`}
            key={t.id}
            // Scrolled into view rather than only tinted: the trace of a long review is
            // taller than the panel, so a highlight below the fold is no help at all.
            ref={
              t.id === highlight
                ? (el) => el?.scrollIntoView({ block: "center", behavior: "smooth" })
                : undefined
            }
          >
            <div className="wf-label" title={`${t.node_id} (${t.kind})`}>
              {t.agent_id ?? t.node_id}
              {out.model ? <span className="muted"> · {out.model}</span> : null}
            </div>
            <div className="wf-track">
              <div
                className={`wf-bar ${t.state}`}
                style={{ left: `${left}%`, width: `${width}%` }}
                title={t.error ?? t.state}
              />
            </div>
            <div className="wf-dur">
              {end > start ? `${((end - start) / 1000).toFixed(1)}s` : "—"}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Findings({ findings }: { findings: FindingRow[] }) {
  const posted = findings.filter((f) => f.status !== "suppressed");
  const suppressed = findings.filter((f) => f.status === "suppressed");

  if (!findings.length) return <div className="empty">no findings recorded</div>;

  return (
    <>
      {posted.map((f) => (
        <div className="finding" key={f.id}>
          <h4>{f.title}</h4>
          <div className="meta">
            <span className={`badge ${f.severity}`}>{f.severity}</span>
            <span className="mono">
              {f.file ? `${f.file}${f.line_start ? `:${f.line_start}` : ""}` : "whole PR"}
            </span>
            <span>{f.category}</span>
            <span>confidence {(f.confidence * 100).toFixed(0)}%</span>
            <span>{f.agent_id}</span>
            {f.agreement_count > 1 ? <span>· {f.agreement_count} agents agree</span> : null}
          </div>
          <div>{f.body}</div>
        </div>
      ))}
      {suppressed.length ? (
        <details>
          <summary className="muted">{suppressed.length} suppressed</summary>
          {suppressed.map((f) => (
            <div className="finding" key={f.id} style={{ opacity: 0.6 }}>
              <h4>{f.title}</h4>
              <div className="meta">
                <span className={`badge ${f.severity}`}>{f.severity}</span>
                <span>{f.suppressed_reason}</span>
              </div>
            </div>
          ))}
        </details>
      ) : null}
    </>
  );
}

/**
 * What each agent produced, what survived triage, and what happened to it since.
 *
 * The distinction this exists to preserve: a review reporting no findings because
 * everything fell below the confidence threshold is a different event from one where the
 * agents found nothing, and both differ again from one where the agent never ran. Those
 * three collapse into "0" everywhere else, and the collapse hides the case most worth
 * looking at — a threshold set too high.
 */
function Rollup({
  detail,
  onOpenTranscript,
}: {
  detail: ReviewDetail;
  onOpenTranscript: (taskId: string) => void;
}) {
  const agentTasks = detail.tasks.filter((t) => t.agent_id);

  /** Findings naming this agent. After a merge, `agent_id` is a comma-joined list. */
  const mine = (agent: string) =>
    detail.findings.filter((f) =>
      f.agent_id
        .split(",")
        .map((a) => a.trim())
        .includes(agent),
    );

  /** What the agent submitted, before triage merged or dropped anything. */
  const produced = (t: (typeof agentTasks)[number]): number | undefined => {
    if (!t.output_json) return undefined;
    try {
      const n = (JSON.parse(t.output_json) as { findings?: number }).findings;
      return typeof n === "number" ? n : undefined;
    } catch {
      return undefined;
    }
  };

  const signalsFor = (findingId: string) =>
    detail.feedback.filter((fb) => fb.finding_id === findingId);

  // Posted is asked of `posted_comment_id`, not of `status`. A finding that was posted and
  // then reacted to becomes `accepted` or `dismissed`, so a status-based count would show
  // it quietly leaving the "posted" column the moment somebody engaged with it.
  const wasPosted = (f: FindingRow) => f.posted_comment_id !== null;

  const distinct = detail.findings.filter((f) => f.status !== "suppressed").length;

  return (
    <>
      <table>
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">Produced</th>
            <th scope="col">After triage</th>
            <th scope="col">Posted</th>
            <th scope="col">Suppressed</th>
          </tr>
        </thead>
        <tbody>
          {agentTasks.map((t) => {
            const agent = t.agent_id as string;
            const found = mine(agent);
            const n = produced(t);
            const suppressed = found.filter((f) => f.status === "suppressed");
            if (t.state === "skipped") {
              return (
                <tr key={t.id}>
                  <td>{agent}</td>
                  <td colSpan={4} className="muted">
                    skipped — {t.error ?? "no reason recorded"}
                  </td>
                </tr>
              );
            }
            if (t.state === "failed") {
              return (
                <tr key={t.id}>
                  <td>{agent}</td>
                  <td colSpan={4} className="muted">
                    failed — {t.error ?? "no error recorded"}
                  </td>
                </tr>
              );
            }
            return (
              <tr key={t.id}>
                <td>{agent}</td>
                <td>{n ?? "—"}</td>
                <td>{found.length - suppressed.length}</td>
                <td>{found.filter(wasPosted).length}</td>
                <td>{suppressed.length}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        <strong>{distinct}</strong> distinct finding(s) after triage. Per-agent rows do not sum to
        that: triage merges findings two or more agents raised independently, and a merged finding
        is counted once for each agent that raised it — which is what makes the agreement signal
        meaningful. <em>Produced</em> is what an agent submitted before triage saw it.
      </p>

      <h4 style={{ marginTop: 20 }}>Findings</h4>
      {detail.findings.length === 0 ? (
        <div className="empty">No findings were recorded for this review.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Finding</th>
              <th scope="col">Agents</th>
              <th scope="col">Disposition</th>
              <th scope="col">Line changed since</th>
              <th scope="col">Transcript</th>
            </tr>
          </thead>
          <tbody>
            {detail.findings.map((f) => {
              const agents = f.agent_id
                .split(",")
                .map((a) => a.trim())
                .filter(Boolean);
              const signals = signalsFor(f.id);
              const lineChanged = signals.find((sg) => sg.signal === "line_changed");
              const others = signals.filter((sg) => sg.signal !== "line_changed");
              // A merged finding has no single transcript, so every contributing agent's
              // task is offered instead of picking one arbitrarily.
              const tasks = f.task_id
                ? detail.tasks.filter((t) => t.id === f.task_id)
                : detail.tasks.filter((t) => t.agent_id && agents.includes(t.agent_id));
              return (
                <tr key={f.id} style={f.status === "suppressed" ? { opacity: 0.65 } : undefined}>
                  <td>
                    <div>{f.title}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      <span className={`badge ${f.severity}`}>{f.severity}</span>{" "}
                      <span className="mono">
                        {f.file ? `${f.file}${f.line_start ? `:${f.line_start}` : ""}` : "whole PR"}
                      </span>
                      {f.status === "suppressed" && f.suppressed_reason ? (
                        <> · suppressed: {f.suppressed_reason}</>
                      ) : null}
                    </div>
                  </td>
                  <td className="muted">{agents.join(", ") || "unknown"}</td>
                  <td>
                    <span className={`badge ${f.status}`}>{f.status}</span>
                    {others.length ? (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {others.map((sg) => sg.signal).join(", ")}
                      </div>
                    ) : null}
                  </td>
                  <td className="muted">
                    {lineChanged ? new Date(lineChanged.created_at).toLocaleDateString() : "—"}
                  </td>
                  <td>
                    {tasks.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      tasks.map((t) => (
                        <button
                          type="button"
                          key={t.id}
                          className="linkish"
                          onClick={() => onOpenTranscript(t.id)}
                        >
                          {t.agent_id}
                        </button>
                      ))
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <details style={{ marginTop: 16 }}>
        <summary className="muted">What these columns mean</summary>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.6, marginTop: 8 }}>
          <p>
            <strong>Line changed since</strong> is not "fixed", and the difference matters. Maestro
            cannot observe a fix. What it observes is that the line a finding pointed at was changed
            by a later commit on this pull request. That happens when somebody acts on the finding,
            and it also happens when they rewrite the function for unrelated reasons, revert it, or
            delete the file. The date is evidence that the code moved, and nothing more — it
            deliberately does not settle the finding or count toward the acceptance rate.
          </p>
          <p>
            <strong>Disposition</strong> is the finding's own status: <em>posted</em> means it was
            shown, <em>accepted</em> and <em>dismissed</em> mean a person ruled on it, and
            <em> suppressed</em> means it was never shown at all — the reason is beside it. Signals
            listed underneath (a reaction, a resolved thread) are separate observations; a finding
            can carry several at once, so they are not collapsed into one word.
          </p>
          <p>
            <strong>Feedback does not survive a re-review.</strong> Re-reviewing a pull request
            replaces its findings, and feedback rows are deleted with them. A finding somebody
            reacted to in an earlier round will show no signals here.
          </p>
        </div>
      </details>
    </>
  );
}

export function Reviews({ reviews }: { reviews: ReviewRow[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [tab, setTab] = useState<"trace" | "findings" | "rollup">("trace");
  /** Set when a rollup row asks for a transcript, so the trace can point at it. */
  const [highlightTask, setHighlightTask] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    api
      .review(selected)
      .then((d) => !cancelled && setDetail(d))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selected]);

  // Keep the open review fresh while it is still running.
  useEffect(() => {
    if (
      !selected ||
      !detail ||
      ["done", "failed", "skipped", "superseded"].includes(detail.review.state)
    )
      return;
    const timer = setInterval(() => {
      api
        .review(selected)
        .then(setDetail)
        .catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [selected, detail]);

  return (
    <div className="split">
      <div className="panel scroll">
        <div className="panel-head">
          Reviews <span className="muted">({reviews.length})</span>
        </div>
        {reviews.length === 0 ? (
          <div className="empty">
            No reviews yet.
            <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
              Run <code>maestro review &lt;pr-url&gt;</code> or start the daemon with --poll.
            </div>
          </div>
        ) : (
          // Every other table in this UI names its columns; this one was the exception.
          <table>
            <thead>
              <tr>
                <th scope="col">Review</th>
                <th scope="col" style={{ textAlign: "right" }}>
                  State
                </th>
              </tr>
            </thead>
            <tbody>
              {reviews.map((r) => (
                // A row that only responds to a click is unreachable by keyboard, which
                // is most of the point of a list you navigate to read errors from.
                <tr
                  key={r.id}
                  className={`clickable ${selected === r.id ? "selected" : ""}`}
                  tabIndex={0}
                  // `aria-selected` was here, and meant nothing: it is only defined for
                  // rows inside a grid, so screen readers dropped it and the keyboard
                  // navigation moved between rows that never said where it had landed.
                  // `aria-current` is valid on any element and says the true thing —
                  // this is the row the detail pane is showing.
                  aria-current={selected === r.id ? "true" : undefined}
                  onClick={() => setSelected(r.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelected(r.id);
                    }
                  }}
                >
                  <td>
                    <div style={{ fontWeight: 550 }}>{r.title ?? `${r.repo}#${r.pr_number}`}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {r.owner}/{r.repo}
                      {r.pr_number ? `#${r.pr_number}` : ""} · {relative(r.created_at)}
                    </div>
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <span className={`badge ${r.state}`}>{r.state}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel scroll">
        {!detail ? (
          <div className="empty">Select a review</div>
        ) : (
          <>
            <div className="panel-head">
              {detail.review.title ?? detail.review.id}
              <span className={`badge ${detail.review.state}`}>{detail.review.state}</span>
              <div className="spacer" />
              <button
                type="button"
                className={tab === "trace" ? "primary" : ""}
                onClick={() => setTab("trace")}
              >
                Trace
              </button>
              <button
                type="button"
                className={tab === "findings" ? "primary" : ""}
                onClick={() => setTab("findings")}
              >
                Findings ({detail.findings.filter((f) => f.status !== "suppressed").length})
              </button>
              <button
                type="button"
                className={tab === "rollup" ? "primary" : ""}
                onClick={() => setTab("rollup")}
              >
                Rollup
              </button>
            </div>
            <div className="panel-body">
              {detail.review.error ? (
                <div className="issues">
                  <div className="issue">{detail.review.error}</div>
                </div>
              ) : null}

              <dl className="kv" style={{ marginBottom: 16 }}>
                <dt>Head</dt>
                <dd className="mono">{detail.review.head_sha?.slice(0, 10)}</dd>
                <dt>Playbook</dt>
                <dd className="mono">{detail.review.playbook_version_id}</dd>
                <dt>Cost</dt>
                <dd>{cost(detail.review.cost_cents)}</dd>
                <dt>Models</dt>
                <dd>
                  {detail.llmCalls.length
                    ? detail.llmCalls
                        .map(
                          (c) =>
                            `${c.provider_id}/${c.model} (${c.steps} steps, ${c.tokens_in}→${c.tokens_out} tok)`,
                        )
                        .join(", ")
                    : "—"}
                </dd>
              </dl>

              {tab === "trace" ? (
                <>
                  <Waterfall tasks={detail.tasks} highlight={highlightTask} />
                  {detail.tasks.some((t) => t.error) ? (
                    <div style={{ marginTop: 16 }}>
                      {detail.tasks
                        .filter((t) => t.error)
                        .map((t) => (
                          <div className="issues" key={t.id}>
                            <div className="issue">
                              <strong>{t.agent_id ?? t.node_id}</strong>: {t.error}
                            </div>
                          </div>
                        ))}
                    </div>
                  ) : null}
                </>
              ) : tab === "rollup" ? (
                <Rollup
                  detail={detail}
                  onOpenTranscript={(taskId) => {
                    // A link that switches tab and then leaves you to find the row again
                    // is not one click away from the transcript, which is the point.
                    setHighlightTask(taskId);
                    setTab("trace");
                  }}
                />
              ) : (
                <Findings findings={detail.findings} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
