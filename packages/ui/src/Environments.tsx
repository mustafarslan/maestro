import { useEffect, useState } from "react";
import { api, type EnvironmentRow } from "./api";

/**
 * What Docker is holding right now, and on whose behalf.
 *
 * Container and image leaks are a named risk of this design: every review starts several
 * containers and commits a snapshot image, and a crash between `prepare` and teardown
 * leaves them behind. `maestro doctor` counts strays, which tells an operator that
 * something leaked but not what — this says which review, which agent, and when the lease
 * expired, which is the difference between a number and something you can act on.
 */
const LIVE = new Set(["creating", "ready", "running", "destroying"]);

function age(iso: string | null): string {
  if (!iso) return "—";
  const secs = (Date.now() - Date.parse(iso)) / 1000;
  if (Number.isNaN(secs)) return "—";
  const abs = Math.abs(secs);
  const unit = abs < 90 ? [secs, "s"] : abs < 5400 ? [secs / 60, "m"] : [secs / 3600, "h"];
  return `${Math.round(unit[0] as number)}${unit[1]}`;
}

export function Environments() {
  const [rows, setRows] = useState<EnvironmentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      api
        .environments()
        .then((r) => setRows(r.environments))
        .catch((e) => setError(String(e)));
    load();
    // Containers appear and disappear on their own; a static list of them is misleading
    // in a way a static list of finished reviews is not.
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  if (error) return <div className="empty">could not load environments: {error}</div>;
  if (!rows) return <div className="empty">loading…</div>;
  if (!rows.length) {
    return (
      <div className="empty">
        No environments recorded yet.
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          One row per container a review starts, kept after teardown so a leak has a history.
        </div>
      </div>
    );
  }

  const live = rows.filter((r) => LIVE.has(r.state));
  const leaked = rows.filter((r) => r.state === "leaked");

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          Environments
          <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
            {live.length} live, {leaked.length} leaked, {rows.length} recorded
          </span>
        </div>
        {leaked.length ? (
          <div className="notice" style={{ margin: "8px 12px" }}>
            {leaked.length} environment(s) could not be destroyed. Run <code>maestro reap</code> to
            collect them; their containers and snapshot images are still using disk.
          </div>
        ) : null}
        <table>
          <thead>
            <tr>
              <th>State</th>
              <th>Kind</th>
              <th>Agent</th>
              <th>Pull request</th>
              <th>Container</th>
              <th>Age</th>
              <th>Lease</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const expired = r.lease_until ? Date.parse(r.lease_until) < Date.now() : false;
              return (
                <tr key={r.id}>
                  <td>
                    <span
                      className={`badge ${r.state === "leaked" ? "failed" : LIVE.has(r.state) ? "running" : "done"}`}
                    >
                      {r.state}
                    </span>
                  </td>
                  <td>{r.kind}</td>
                  <td>{r.agent_id ?? <span className="muted">—</span>}</td>
                  <td className="muted">
                    {r.repo}#{r.pr_number}
                  </td>
                  <td className="muted" style={{ fontFamily: "ui-monospace, monospace" }}>
                    {r.container_id ? r.container_id.slice(0, 12) : "—"}
                  </td>
                  <td className="muted">{age(r.created_at)}</td>
                  <td className={expired && LIVE.has(r.state) ? "" : "muted"}>
                    {/* An expired lease on something still marked live is what the reaper
                        looks for; saying so here is why the page is worth opening. */}
                    {LIVE.has(r.state)
                      ? expired
                        ? `expired ${age(r.lease_until)} ago`
                        : `${age(r.lease_until)} left`
                      : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
