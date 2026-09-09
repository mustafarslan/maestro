import type { ProvidersResponse, StatsResponse } from "./api";

export function Providers({
  providers,
  stats,
}: {
  providers: ProvidersResponse | null;
  stats: StatsResponse | null;
}) {
  if (!providers) return <div className="empty">loading…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="panel">
        <div className="panel-head">Providers</div>
        <table>
          <thead>
            <tr>
              <th>Id</th>
              <th>Kind</th>
              <th>Base URL</th>
              <th>Models cached</th>
            </tr>
          </thead>
          <tbody>
            {providers.providers.map((p) => {
              const models = providers.models.filter((m) => m.providerId === p.id);
              return (
                <tr key={p.id}>
                  <td style={{ fontWeight: 550 }}>{p.id}</td>
                  <td className="muted">{p.kind}</td>
                  <td className="mono muted">{p.baseUrl ?? "—"}</td>
                  <td>
                    {models.length ? (
                      `${models.length}`
                    ) : (
                      <span className="muted">
                        run <code>maestro llm models</code>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <div className="panel-head">Spend</div>
        {stats?.spend.length ? (
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Model</th>
                <th>Calls</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {stats.spend.map((s) => (
                <tr key={`${s.provider_id}/${s.model}`}>
                  <td>{s.provider_id}</td>
                  <td className="mono">{s.model}</td>
                  <td>{s.calls}</td>
                  {/* Zero cost means unpriced, not free - saying "free" would be a lie. */}
                  <td>
                    {s.cost_cents > 0 ? (
                      `${s.cost_cents.toFixed(2)}¢`
                    ) : (
                      <span className="muted">unpriced</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">no model calls recorded yet</div>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">Queue &amp; environments</div>
        <div className="panel-body">
          <dl className="kv">
            <dt>Jobs</dt>
            <dd>
              {Object.entries(stats?.queue ?? {})
                .map(([k, v]) => `${v} ${k}`)
                .join(", ") || "idle"}
            </dd>
            <dt>Reviews</dt>
            <dd>{(stats?.reviews ?? []).map((r) => `${r.n} ${r.state}`).join(", ") || "none"}</dd>
            <dt>Environments</dt>
            <dd>
              {(stats?.environments ?? []).map((e) => `${e.n} ${e.state}`).join(", ") ||
                "none tracked"}
            </dd>
          </dl>
        </div>
      </div>
    </div>
  );
}
