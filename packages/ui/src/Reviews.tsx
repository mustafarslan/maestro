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
function Waterfall({ tasks }: { tasks: TaskRow[] }) {
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
          <div className="wf-row" key={t.id}>
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

export function Reviews({ reviews }: { reviews: ReviewRow[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [tab, setTab] = useState<"trace" | "findings">("trace");

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
          <table>
            <tbody>
              {reviews.map((r) => (
                <tr
                  key={r.id}
                  className={`clickable ${selected === r.id ? "selected" : ""}`}
                  onClick={() => setSelected(r.id)}
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
              <button className={tab === "trace" ? "primary" : ""} onClick={() => setTab("trace")}>
                Trace
              </button>
              <button
                className={tab === "findings" ? "primary" : ""}
                onClick={() => setTab("findings")}
              >
                Findings ({detail.findings.filter((f) => f.status !== "suppressed").length})
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
                  <Waterfall tasks={detail.tasks} />
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
