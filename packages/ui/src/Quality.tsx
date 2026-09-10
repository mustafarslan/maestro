import { useEffect, useState } from "react";
import { api, type EvalResponse, type FeedbackResponse } from "./api";

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
  const [evals, setEvals] = useState<EvalResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .feedback()
      .then(setData)
      .catch((e) => setError(String(e)));
    // Failing to load the golden-set scores must not blank the acceptance table: they
    // are two independent signals and a fresh install has the second and not the first.
    api
      .evalScores()
      .then(setEvals)
      .catch(() => setEvals({ scores: [], comparisons: [], deltas: [] }));
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
  // Weaker evidence, shown beside the verdicts rather than mixed into them: this counts
  // findings on a file the author edited afterwards, which a developer working on
  // something unrelated produces just as readily as one acting on the finding. It used to
  // settle findings as accepted, which inflated the rate to near 100% and, less visibly,
  // emptied the carry-forward list on every push.
  const touched = (agent: string) => data.lineChanged?.find((r) => r.agent_id === agent)?.n ?? 0;

  if (!agents.length) {
    return (
      <>
        <div className="empty">
          No findings yet.
          <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            Acceptance is gathered from reactions on posted comments and from whether a flagged line
            was changed later.
          </div>
        </div>
        <Golden evals={evals} />
      </>
    );
  }

  return (
    <>
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
              <th>File touched after</th>
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
                  <td className={touched(a) ? undefined : "muted"}>{touched(a)}</td>
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
      <Golden evals={evals} />
    </>
  );
}

/**
 * Precision and recall per playbook version, from the golden set.
 *
 * The plan's exit for the quality loop is that the UI shows accepted-versus-dismissed by
 * agent *and* a version-versus-version comparison. `compareVersions` has existed since the
 * eval harness landed and only the CLI and MCP could reach it, so half of that exit was
 * met by neither surface.
 *
 * These two tables answer different questions and must not be conflated: acceptance is
 * what humans did with real findings, and this is what a fixed set of known defects says
 * about a prompt or model change. The second is the one you can run before shipping.
 */
function Golden({ evals }: { evals: EvalResponse | null }) {
  if (!evals) return null;
  const pct = (v?: number) =>
    v === undefined ? <span className="muted">—</span> : `${Math.round(v * 100)}%`;

  if (!evals.comparisons.length) {
    return (
      <div className="panel">
        <div className="panel-head">Golden set by playbook version</div>
        <div className="panel-body muted" style={{ fontSize: 12 }}>
          No scored runs yet. Add a fixture with <code>maestro eval add</code> and score it with{" "}
          <code>maestro eval run</code>; the results appear here grouped by the playbook version
          that produced them, which is what makes a prompt or model change measurable rather than
          guessed at.
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-head">Golden set by playbook version</div>
      <table>
        <thead>
          <tr>
            <th>Playbook version</th>
            <th>Split</th>
            <th>Runs</th>
            <th>Precision</th>
            <th>Recall</th>
            <th>False positives</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {evals.comparisons.map((c) => (
            <tr key={`${c.playbookVersionId}-${c.split}`}>
              <td style={{ fontFamily: "ui-monospace, monospace" }}>{c.playbookVersionId}</td>
              <td className={c.split === "val" ? undefined : "muted"}>
                {c.split === "val" ? "held out" : "training"}
              </td>
              <td className="muted">{c.runs}</td>
              <td>{pct(c.precision)}</td>
              <td>{pct(c.recall)}</td>
              <td className={c.falsePositives ? undefined : "muted"}>{c.falsePositives}</td>
              <td className="muted">{(c.costCents / 100).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="panel-body muted" style={{ fontSize: 12 }}>
        Held-out and training fixtures are reported as separate rows and never pooled — the number a
        change is chosen by and the number it is judged by have to be different numbers. Precision
        is undefined when a version reported nothing, and recall when a fixture expects nothing —
        neither is zero, and showing them as zero would make a cautious version look broken. These
        numbers never appear in a pull request comment: they are not computable when a review is
        written.
      </div>
    </div>
  );
}
