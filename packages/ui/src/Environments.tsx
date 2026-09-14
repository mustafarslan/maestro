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
// No state vocabulary here at all. This file used to keep its own set of "live" states,
// enumerating three — creating, ready, destroying — that nothing ever writes, which implied
// a lifecycle the code does not have. The UI is a browser bundle and cannot import the
// canonical list from `core`, so rather than duplicate it the server now decides: each row
// arrives with `live`, computed there from the one definition.

function age(iso: string | null): string {
  if (!iso) return "—";
  const secs = (Date.now() - Date.parse(iso)) / 1000;
  if (Number.isNaN(secs)) return "—";
  // Magnitude only: the caller supplies the direction ("4m left" / "expired 4m ago").
  // Rounding the signed value printed a healthy container's lease as `-4m left`.
  const abs = Math.abs(secs);
  const unit: [number, string] =
    abs < 90 ? [abs, "s"] : abs < 5400 ? [abs / 60, "m"] : [abs / 3600, "h"];
  return `${Math.round(unit[0])}${unit[1]}`;
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

  const live = rows.filter((r) => r.live);
  // A leaked row keeps its state for ever — that a review could not clean up after
  // itself is worth remembering — so "still leaking" is the ones no sweep has collected.
  const leaked = rows.filter((r) => r.state === "leaked" && !r.destroyed_at);

  return (
    <div className="panel">
      <div className="panel-head">
        Environments
        <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
          {live.length} live, {leaked.length} leaked, {rows.length} recorded
        </span>
      </div>
      {leaked.length ? (
        <div className="notice" style={{ margin: "8px 12px" }}>
          {leaked.length} environment(s) could not be destroyed by the review that created them. Run{" "}
          <code>maestro reap</code> to collect them; until then their containers and snapshot images
          are still using disk.
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
                    className={`badge ${r.state === "leaked" ? "failed" : r.live ? "running" : "done"}`}
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
                <td className={expired && r.live ? "" : "muted"}>
                  {/* `lease_until` is stamped once, at creation, as prepare plus analyze
                        timeouts; nothing renews it. So an expired lease on a row still
                        marked live means the environment has outlived the entire time
                        both its phases were allowed — which nothing legitimate does. It
                        is not what `reap` keys on: that sweeps by Docker label and age,
                        which is why this is a signal to look rather than a duplicate of
                        the reaper's own state. */}
                  {r.live
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
  );
}
