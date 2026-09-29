import { useCallback, useEffect, useState } from "react";
import {
  api, type AppConfig, type FlaggedHost, type PortfolioInfo, type QualityOs, type TriageRow,
} from "../lib/api";
import { downloadCsv, fmt, fmtDate, hostTypeLabel } from "../lib/format";
import { usePersisted } from "../lib/hooks";
import { MultiSelect } from "../components/MultiSelect";

const FLAG_INFO: { key: keyof QualityOs["flags"]; label: string; hint: string }[] = [
  { key: "unmapped", label: "Unknown portfolio", hint: "no portfolio from the feed or the owner map" },
  { key: "unowned", label: "No owner", hint: "host has no owner in the CMDB" },
  { key: "departed", label: "Departed owner", hint: "owner has left; hosts need a new owner" },
  { key: "remediated", label: "Remediated since last refresh", hint: "upgraded off the EOL OS in the latest refresh" },
];

export function ActualsTab({ config }: { config: AppConfig }) {
  const [osSel, setOsSel] = usePersisted<string[]>("actuals.os", config.tracked_os);
  const [quality, setQuality] = useState<QualityOs[]>([]);
  const [flagged, setFlagged] = useState<FlaggedHost[]>([]);
  const [triage, setTriage] = useState<TriageRow[]>([]);
  const [snapshots, setSnapshots] = useState<{ date: string; counts: Record<string, number> }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([api.quality(), api.triage(), api.snapshots()])
      .then(([q, t, s]) => {
        setQuality(q);
        setTriage(t);
        setSnapshots(s);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);
  useEffect(() => {
    if (osSel.length) api.flagged(osSel).then((r) => setFlagged(r.hosts)).catch(() => setFlagged([]));
    else setFlagged([]);
  }, [osSel, triage]);

  const shownQuality = quality.filter((q) => osSel.includes(q.os));
  const shownTriage = triage.filter((t) => Object.keys(t.os).some((o) => osSel.includes(o)));

  return (
    <div className="actuals">
      <div className="toolbar">
        <p className="lead">
          Point-in-time actuals from the <b>{config.source}</b> as of <b>{fmtDate(config.as_of)}</b>. In the original tool
          this tab pulled a fresh inventory on demand; the demo uses a fixed snapshot.
        </p>
        <label className="fb-field push">
          <span>OS</span>
          <MultiSelect
            noun="OS"
            allLabel="All tracked OS"
            options={config.tracked_os.map((o) => ({ value: o }))}
            selected={osSel}
            onChange={setOsSel}
          />
        </label>
      </div>
      {error && <div className="notice bad">{error}</div>}

      <div className="cards">
        {shownQuality.map((q) => (
          <section key={q.os} className="card">
            <h3>{q.os} | data quality</h3>
            <div className="dq-grid">
              <div className="dq">
                <div className="kpi-value">{fmt(q.remaining)}</div>
                <div className="kpi-label">Remaining hosts</div>
              </div>
              {FLAG_INFO.map((f) => (
                <div key={f.key} className={q.flags[f.key] ? "dq flagged" : "dq"} title={f.hint}>
                  <div className="kpi-value">{fmt(q.flags[f.key])}</div>
                  <div className="kpi-label">{f.label}</div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      <Triage rows={shownTriage} onChanged={load} />

      <section className="card section">
        <h3>Remaining hosts by portfolio</h3>
        <div className="two-col">
          {shownQuality.map((q) => (
            <table key={q.os} className="table compact">
              <thead>
                <tr><th>{q.os}</th><th>Full name</th><th className="num">Owners</th><th className="num">Hosts</th></tr>
              </thead>
              <tbody>
                {q.portfolios.map((p) => (
                  <tr key={p.portfolio}>
                    <td>{p.portfolio}</td>
                    <td className="muted">{p.full_name}</td>
                    <td className="num">{fmt(p.owners)}</td>
                    <td className="num">{fmt(p.hosts)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><td colSpan={3}><b>Total</b></td><td className="num"><b>{fmt(q.remaining)}</b></td></tr>
              </tfoot>
            </table>
          ))}
        </div>
      </section>

      <NeedsReview hosts={flagged} asOf={config.as_of} />

      <section className="card section">
        <h3>Refresh history</h3>
        <p className="muted small">Daily host counts from the {config.source}, most recent first (last 30 refreshes).</p>
        <div className="scroll-table short">
          <table className="table compact">
            <thead>
              <tr><th>Date</th>{config.tracked_os.map((o) => <th key={o} className="num">{o}</th>)}</tr>
            </thead>
            <tbody>
              {snapshots.map((s) => (
                <tr key={s.date}>
                  <td>{fmtDate(s.date)}</td>
                  {config.tracked_os.map((o) => <td key={o} className="num">{fmt(s.counts[o])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Triage({ rows, onChanged }: { rows: TriageRow[]; onChanged: () => void }) {
  const [portfolios, setPortfolios] = useState<PortfolioInfo[]>([]);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: string; text: string } | null>(null);

  useEffect(() => {
    api.portfolios().then((p) => setPortfolios(p.filter((x) => x.origin === "mapping")));
  }, []);

  const assign = async (owner: string) => {
    const pf = choice[owner];
    if (saving || !pf) return;
    setSaving(owner);
    setMsg({ tone: "info", text: `Saving ${owner} → ${pf}…` });
    try {
      const r = await api.setOwnerMap(owner, pf);
      setMsg({ tone: "ok", text: `${owner} → ${pf}: ${r.hosts_updated} hosts re-assigned.` });
      onChanged();
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="card section">
      <h3>Owner triage <span className="count-pill">{rows.length}</span></h3>
      <p className="muted small">
        Owners that need attention each refresh: new owners, owners with no portfolio, departed owners, and hosts with no
        owner. Assigning a portfolio updates the owner map and re-files that owner's hosts immediately.
      </p>
      {msg && <div className={`status ${msg.tone}`}>{msg.text}</div>}
      <table className="table compact">
        <thead>
          <tr><th>Owner</th><th>Name</th><th>Why</th><th className="num">Hosts</th><th>Current portfolio</th><th>Assign portfolio</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.owner}>
              <td className="mono">{r.owner}</td>
              <td>{r.display_name || "-"}</td>
              <td>{r.reasons.map((x) => <span key={x} className="tag warn">{x}</span>)}</td>
              <td className="num">{fmt(r.hosts)}</td>
              <td>{r.portfolio}</td>
              <td>
                {r.assignable ? (
                  <span className="inline-form">
                    <select
                      disabled={!!saving}
                      value={choice[r.owner] ?? ""}
                      onChange={(e) => setChoice({ ...choice, [r.owner]: e.target.value })}
                    >
                      <option value="">Choose…</option>
                      {portfolios.map((p) => <option key={p.code} value={p.code}>{p.code}</option>)}
                    </select>
                    <button className="btn small" disabled={!!saving || !choice[r.owner]} onClick={() => assign(r.owner)}>
                      {saving === r.owner ? "Saving…" : "Save"}
                    </button>
                  </span>
                ) : (
                  <span className="muted small">needs an owner first</span>
                )}
              </td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={6} className="muted">Nothing to triage.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}

function NeedsReview({ hosts, asOf }: { hosts: FlaggedHost[]; asOf: string }) {
  const shown = hosts.slice(0, 200);
  const exportCsv = () =>
    downloadCsv(
      `needs_review_${asOf}.csv`,
      ["Hostname", "OS", "Host Type", "Portfolio", "Owner", "Owner Status", "Flags"],
      hosts.map((h) => [h.hostname, h.os, hostTypeLabel(h.host_type), h.portfolio, h.owner, h.owner_status, h.flags.join("; ")]),
    );
  return (
    <section className="card section">
      <div className="drill-head">
        <h3>Needs review <span className="count-pill">{fmt(hosts.length)}</span></h3>
        <button className="btn" onClick={exportCsv} disabled={!hosts.length}>⤓ Export CSV</button>
      </div>
      <p className="muted small">
        {hosts.length > 200 ? `Showing the first 200 of ${fmt(hosts.length)}; the export includes all.` : "Hosts with at least one data-quality flag."}
      </p>
      <div className="scroll-table">
        <table className="table compact">
          <thead>
            <tr><th>Hostname</th><th>OS</th><th>Type</th><th>Portfolio</th><th>Owner</th><th>Owner status</th><th>Flags</th></tr>
          </thead>
          <tbody>
            {shown.map((h) => (
              <tr key={h.hostname}>
                <td className="mono">{h.hostname}</td>
                <td>{h.os}</td>
                <td>{hostTypeLabel(h.host_type)}</td>
                <td>{h.portfolio}</td>
                <td>{h.owner}</td>
                <td className="cap">{h.owner_status}</td>
                <td>{h.flags.map((f) => <span key={f} className="tag warn">{f}</span>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
