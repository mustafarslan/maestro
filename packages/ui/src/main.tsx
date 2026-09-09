import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, type ProvidersResponse, type ReviewRow, type StatsResponse, TOKEN } from "./api";
import { Providers } from "./Providers";
import { Quality } from "./Quality";
import { Reviews } from "./Reviews";
import { Studio } from "./Studio";
import "./styles.css";

type Tab = "reviews" | "studio" | "providers" | "quality";

function App() {
  const [tab, setTab] = useState<Tab>("reviews");
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [providers, setProviders] = useState<ProvidersResponse | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api
      .reviews()
      .then((r) => {
        setReviews(r.reviews);
        setError(null);
      })
      .catch((e) => setError(String(e)));
    api
      .stats()
      .then(setStats)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    api
      .providers()
      .then(setProviders)
      .catch(() => {});
  }, [refresh]);

  // Server-sent events push changes as they happen; the interval is the fallback for a
  // dropped connection, so the board is never silently stale.
  useEffect(() => {
    if (!TOKEN) return;
    const source = new EventSource(`/api/events?token=${encodeURIComponent(TOKEN)}`);
    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false);
    source.onmessage = () => refresh();
    source.addEventListener("review", refresh);
    source.addEventListener("playbook", refresh);
    const poll = setInterval(refresh, 10_000);
    return () => {
      source.close();
      clearInterval(poll);
    };
  }, [refresh]);

  if (!TOKEN) {
    return (
      <div className="empty">
        <h3>Admin token required</h3>
        <p className="muted">
          Open the URL printed by <code>maestro serve</code>, which includes <code>?token=…</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">Maestro</div>
        <div className="tabs">
          {(["reviews", "studio", "providers", "quality"] as Tab[]).map((t) => (
            <button
              type="button"
              key={t}
              className={`tab ${tab === t ? "active" : ""}`}
              onClick={() => setTab(t)}
            >
              {t === "studio" ? "Playbook Studio" : t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <div className="spacer" />
        {error ? <span className="badge failed">{error}</span> : null}
        <div className="live">
          <span className={`dot ${live ? "" : "off"}`} />
          {live ? "live" : "polling"}
        </div>
      </div>
      <div className="main">
        {tab === "reviews" ? <Reviews reviews={reviews} /> : null}
        {tab === "studio" ? <Studio providers={providers} /> : null}
        {tab === "providers" ? <Providers providers={providers} stats={stats} /> : null}
        {tab === "quality" ? <Quality /> : null}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
