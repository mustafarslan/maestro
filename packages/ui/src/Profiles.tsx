import { useCallback, useEffect, useState } from "react";
import { api, type ProfileDetail, type ProfilesResponse } from "./api";

/**
 * Developer profiles: who reviews run as, how much of each profile is observed, and the
 * battery items to read before trusting one.
 *
 * Activation lives here as well as on the CLI because it is the one switch that changes what
 * every subsequent review says and whether it blocks a pull request, and the person watching
 * the review board is the one who should be able to see and flip it.
 */
export function Profiles() {
  const [data, setData] = useState<ProfilesResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProfileDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .profiles()
      .then((d) => {
        setData(d);
        setError(null);
        setSelected((s) => s ?? d.active ?? d.profiles[0]?.subject ?? null);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    api
      .profile(selected)
      .then((r) => setDetail(r.profile))
      .catch(() => setDetail(null));
  }, [selected]);

  const toggle = async (subject: string, activate: boolean) => {
    setBusy(true);
    try {
      const r = activate ? await api.activateProfile(subject) : await api.deactivateProfile();
      setError(r.ok ? null : (r.error ?? "could not change the active profile"));
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) return <div className="empty">could not load profiles: {error}</div>;
  if (!data) return <div className="empty">loading…</div>;

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          Developer profiles
          <span className="muted" style={{ marginLeft: 8, fontWeight: 400 }}>
            battery {data.battery.version} · {data.battery.items} items
          </span>
        </div>
        {error ? <div className="panel-body badge failed">{error}</div> : null}
        {data.profiles.length === 0 ? (
          <div className="panel-body muted">
            No profiles yet. Answer the battery with{" "}
            <code>maestro profile take --subject &lt;login&gt;</code>.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Subject</th>
                <th>Answered</th>
                <th>Updated</th>
                <th>Reviews run as</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.profiles.map((p) => (
                <tr key={p.subject}>
                  <td>
                    <button
                      type="button"
                      className="link"
                      style={{ fontWeight: selected === p.subject ? 650 : 450 }}
                      onClick={() => setSelected(p.subject)}
                    >
                      {p.subject}
                    </button>
                  </td>
                  <td>
                    {p.answered} / {data.battery.items}
                  </td>
                  <td className="muted">{new Date(p.updatedAt).toLocaleString()}</td>
                  <td>
                    {p.active ? (
                      <span className="badge done">active</span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void toggle(p.subject, !p.active)}
                    >
                      {p.active ? "Deactivate" : "Activate"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="panel-body muted" style={{ fontSize: 12 }}>
          With a profile active, the specialists still review without it; the triage agent then
          decides the final review as that developer would, inside rules Maestro enforces, and the
          pull request is marked Request changes when their profile blocks it.
        </div>
      </div>

      {detail ? <ProfileScores detail={detail} /> : null}

      <div className="panel">
        <div className="panel-head">Review first</div>
        <div className="panel-body muted" style={{ fontSize: 12 }}>
          The battery's authors shipped these items on judgement rather than on a clean automated
          audit. Read them before trusting a profile that leans on them.
        </div>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Scenario</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {data.reviewFirst.map((r) => (
              <tr key={r.id}>
                <td style={{ fontWeight: 550 }}>{r.id}</td>
                <td>{r.title}</td>
                <td className="muted">{r.note ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Bar({ value }: { value: number | null }) {
  if (value === null) return <span className="muted">unobserved</span>;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span
        style={{
          display: "inline-block",
          width: 120,
          height: 6,
          borderRadius: 3,
          overflow: "hidden",
          background: "rgba(127,127,127,0.25)",
        }}
      >
        <span
          style={{
            display: "block",
            width: `${Math.round(value * 100)}%`,
            height: "100%",
            background: "currentColor",
          }}
        />
      </span>
      {value.toFixed(2)}
    </span>
  );
}

function ProfileScores({ detail }: { detail: ProfileDetail }) {
  const p = detail.profile;
  const rows = (entries: [string, number | null][], counts: Record<string, number>) =>
    entries.map(([k, v]) => (
      <tr key={k}>
        <td>{k.replaceAll("_", " ")}</td>
        {/* A default of 0.5 for a topic nobody answered is not a measurement; say so. */}
        <td>
          <Bar value={counts[k] ? v : null} />
        </td>
        <td className="muted">n={counts[k] ?? 0}</td>
      </tr>
    ));

  return (
    <div className="panel">
      <div className="panel-head">
        {detail.subject}
        <span className="muted" style={{ marginLeft: 8, fontWeight: 400 }}>
          {detail.answered} answered
        </span>
      </div>
      <div className="panel-body" style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <span>
          framing <b>{p.framingStrategy ?? "unobserved"}</b>
        </span>
        <span>
          cognitive style <b>{p.kaiClassification ?? "unobserved"}</b>
        </span>
        <span>
          regulatory focus <b>{p.regulatoryFocusLabel ?? "unobserved"}</b>
        </span>
        <span>
          politeness tags <b>{p.useNegativePolitenessTags ? "yes" : "no"}</b>
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Core attribute</th>
            <th>Score</th>
            <th />
          </tr>
        </thead>
        <tbody>{rows(Object.entries(p.attributes), p.coverage.nPerAttribute)}</tbody>
      </table>
      <table>
        <thead>
          <tr>
            <th>Topic weight</th>
            <th>Score</th>
            <th />
          </tr>
        </thead>
        <tbody>{rows(Object.entries(p.topicWeights), p.coverage.nPerTopic)}</tbody>
      </table>
      <table>
        <thead>
          <tr>
            <th>Style signal</th>
            <th>Score</th>
            <th />
          </tr>
        </thead>
        <tbody>{rows(Object.entries(p.extendedSignals), p.coverage.nPerExtendedSignal)}</tbody>
      </table>
    </div>
  );
}
