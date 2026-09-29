import { useCallback, useEffect, useState } from "react";
import { api, type AppConfig, type Meta } from "./lib/api";
import { fmtDate, fmtStamp } from "./lib/format";
import { usePersisted } from "./lib/hooks";
import { InsightsTab } from "./tabs/InsightsTab";
import { PlannedTab } from "./tabs/PlannedTab";
import { ActualsTab } from "./tabs/ActualsTab";
import { MappingTab } from "./tabs/MappingTab";

const TABS = [
  { id: "insights", label: "Insights" },
  { id: "planned", label: "Planned" },
  { id: "actuals", label: "Actuals" },
  { id: "mapping", label: "Mapping / Settings" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function App() {
  const [tab, setTab] = usePersisted<TabId>("app.tab", "insights");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped after a demo reset so every tab remounts and refetches.
  const [epoch, setEpoch] = useState(0);

  const loadMeta = useCallback(() => {
    api.meta().then(setMeta).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    loadMeta();
    api.config().then(setConfig).catch((e) => setError(e.message));
  }, [loadMeta, epoch]);

  const onReset = () => {
    setEpoch((n) => n + 1);
  };

  return (
    <div className="app">
      <header className="banner">
        <div className="brand">
          <div className="app-name">Horizon</div>
          <div className="app-tagline">End-of-Life Tracker</div>
        </div>
        <div className="banner-right">
          {meta && (
            <div className="pill" title={`Point-in-time data as of ${fmtDate(meta.as_of)}`}>
              Last refreshed: {fmtStamp(meta.last_refresh)}
            </div>
          )}
          <div className="pill pill-demo" title={meta?.dataset ?? ""}>Synthetic demo data</div>
        </div>
      </header>

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? "tab active" : "tab"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="content" key={epoch}>
        {error && <div className="notice bad">{error}</div>}
        {config && meta && (
          <>
            {tab === "insights" && <InsightsTab config={config} />}
            {tab === "planned" && <PlannedTab config={config} onSaved={loadMeta} />}
            {tab === "actuals" && <ActualsTab config={config} />}
            {tab === "mapping" && <MappingTab config={config} onReset={onReset} />}
          </>
        )}
      </main>

      <footer className="footer">
        Horizon is a portfolio demo. All hosts, owners, host counts and plans are synthetic.
      </footer>
    </div>
  );
}
