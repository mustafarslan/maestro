import { useEffect, useState } from "react";
import { api, type FeedbackResponse } from "./api";

const STATUS_ORDER = ["posted", "open", "accepted", "dismissed", "suppressed"] as const;

/**
 * The post-hoc quality loop.
 *
 * Deliberately separate from anything a pull request comment shows. Precision is not
 * computable when a review is written — it needs human judgement that has not happened
 * yet — so it is gathered afterwards from reactions and later edits and shown only here.
 * A comment that claimed its own accuracy would be inventing the number.
 */
export function Quality() {
  const [data, setData] = useState<FeedbackResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .feedback()
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="empty">could not load feedback: {error}</div>;
  if (!data) return <div className="empty">loading…</div>;

  const agents = [...new Set(data.byAgent.map((r) => r.agent_id))].sort();
  const count = (agent: string, status: string) =>
    data.byAgent.find((r) => r.agent_id === agent && r.status === status)?.n ?? 0;

  // Only findings a human actually ruled on. Suppressed ones never reached anybody, and
  // counting them as anything would make a quiet agent look accurate.
  //
  // The rate comes from the server rather than being recomputed here: two implementations
  // of one number is how they end up disagreeing.
  const rateOf = (agent: string) => data.quality?.find((q) => q.agentId === agent)?.acceptanceRate;
  const judged = (agent: string) => count(agent, "accepted") + count(agent, "dismissed");

  if (!agents.length) {
    return (
      <div className="empty">
        No findings yet.
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          Acceptance is gathered from reactions on posted comments and from whether a flagged line
          was changed later.
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-head">Findings by agent</div>
      <table>
        <thead>
          <tr>
            <th>Agent</th>
            {STATUS_ORDER.map((s) => (
              <th key={s}>{s}</th>
            ))}
            <th>Accepted of judged</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => {
            const total = judged(a);
            return (
              <tr key={a}>
                <td style={{ fontWeight: 550 }}>{a}</td>
                {STATUS_ORDER.map((s) => (
                  <td key={s} className={count(a, s) ? undefined : "muted"}>
                    {count(a, s)}
                  </td>
                ))}
                <td>
                  {rateOf(a) === undefined || total === 0 ? (
                    // A rate over zero judgements is not a small number, it is no number.
                    <span className="muted">no verdicts yet</span>
                  ) : (
                    <>
                      {Math.round((rateOf(a) as number) * 100)}%
                      <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>
                        of {total}
                      </span>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="panel-body muted" style={{ fontSize: 12 }}>
        Suppressed findings were never shown to anyone, so they count towards neither column.
        Acceptance comes from reactions on the posted comment and from whether a flagged line was
        changed in a later commit.
      </div>
    </div>
  );
}
