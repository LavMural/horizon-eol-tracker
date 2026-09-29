import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  api, getActor, setActor, type AppConfig, type ImportResult, type OwnerOption, type PlanAudit, type PlanLine,
  type PortfolioInfo,
} from "../lib/api";
import { fmt, fmtAxis, fmtMonth, fmtStamp, niceTicks } from "../lib/format";
import { usePersisted } from "../lib/hooks";
import { ChartTooltip, OTHER_COLOR, PALETTE } from "../components/charts";

interface Row extends PlanLine {
  key: string;
  dirty: boolean;
}

let keySeq = 0;
const toRow = (l: PlanLine): Row => ({ ...l, key: `r${++keySeq}`, dirty: false });
const rowTotal = (r: PlanLine) => Object.values(r.months).reduce((a, b) => a + (b || 0), 0);

export function PlannedTab({ config, onSaved }: { config: AppConfig; onSaved: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [portfolios, setPortfolios] = useState<PortfolioInfo[]>([]);
  const [owners, setOwners] = useState<OwnerOption[]>([]);
  const [osFilter, setOsFilter] = usePersisted<string>("planned.os", "all");
  const [status, setStatus] = useState<{ tone: string; text: string } | null>(null);
  const [actor, setActorState] = useState(getActor());
  const [logKey, setLogKey] = useState(0);
  const [lastSaved, setLastSaved] = useState<string | null>(null);

  const load = useCallback(() => {
    return Promise.all([api.planned(), api.meta()]).then(([lines, meta]) => {
      setRows(lines.map(toRow));
      setLastSaved(meta.planned_last_saved);
    });
  }, []);

  useEffect(() => {
    load().catch((e) => setStatus({ tone: "bad", text: e.message }));
    api.portfolios().then((p) => setPortfolios(p.filter((x) => x.origin !== "system")));
    api.owners().then(setOwners);
  }, [load]);

  const mapped = useMemo(() => new Set(portfolios.map((p) => p.code)), [portfolios]);
  const ownerSet = useMemo(() => new Set(owners.map((o) => o.username)), [owners]);
  const visible = rows.filter((r) => osFilter === "all" || r.os === osFilter);
  const dirtyCount = rows.filter((r) => r.dirty).length;

  const update = (key: string, patch: Partial<PlanLine>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch, dirty: true } : r)));
  const setMonth = (key: string, m: string, v: string) =>
    setRows((rs) =>
      rs.map((r) => (r.key === key ? { ...r, months: { ...r.months, [m]: Math.max(0, Number(v) || 0) }, dirty: true } : r)),
    );

  const after = (text: string) => {
    setStatus({ tone: "ok", text });
    setLogKey((k) => k + 1);
    onSaved();
  };

  const saveRow = async (r: Row) => {
    if (!r.portfolio) return setStatus({ tone: "bad", text: "Pick a portfolio before saving." });
    try {
      const saved = r.id == null ? await api.createPlan(r) : await api.updatePlan(r);
      await load();
      after(`Saved ${saved.os} | ${saved.portfolio}${saved.owner ? ` | ${saved.owner}` : ""}.`);
    } catch (e) {
      setStatus({ tone: "bad", text: (e as Error).message });
    }
  };

  const saveAll = async () => {
    const dirty = rows.filter((r) => r.dirty);
    try {
      for (const r of dirty) {
        if (!r.portfolio) throw new Error("Every row needs a portfolio before saving.");
        await (r.id == null ? api.createPlan(r) : api.updatePlan(r));
      }
      await load();
      after(`Saved ${dirty.length} row(s).`);
    } catch (e) {
      setStatus({ tone: "bad", text: (e as Error).message });
    }
  };

  const removeRow = async (r: Row) => {
    if (r.id == null) return setRows((rs) => rs.filter((x) => x.key !== r.key));
    if (!confirm(`Delete the plan line ${r.os} | ${r.portfolio}${r.owner ? ` | ${r.owner}` : ""}?`)) return;
    try {
      await api.deletePlan(r.id);
      await load();
      after("Deleted 1 row.");
    } catch (e) {
      setStatus({ tone: "bad", text: (e as Error).message });
    }
  };

  const addRow = (copy?: Row) =>
    setRows((rs) => [
      ...rs,
      {
        ...(copy ?? {
          os: osFilter !== "all" ? osFilter : config.tracked_os[0],
          portfolio: "",
          application: "",
          owner: "",
          months: {},
        }),
        id: null,
        entry_date: config.as_of,
        last_changed_by: null,
        last_changed_at: null,
        key: `r${++keySeq}`,
        dirty: true,
      } as Row,
    ]);

  const monthTotals = config.months.map((m) => visible.reduce((a, r) => a + (r.months[m] || 0), 0));

  return (
    <div className="planned">
      <p className="lead">
        Plans come from host owners: how many hosts each will decommission (or upgrade off the EOL OS) in each month.
        Owner is the owner's username, the same one the CMDB uses, so plans join to actual hosts exactly.
      </p>

      <PlanChart rows={visible} months={config.months} />

      <div className="toolbar">
        <label className="fb-field">
          <span>OS</span>
          <select className="fb-select" value={osFilter} onChange={(e) => setOsFilter(e.target.value)}>
            <option value="all">All OS</option>
            {config.tracked_os.map((o) => <option key={o}>{o}</option>)}
          </select>
        </label>
        <button className="btn" onClick={() => addRow()}>+ Add line</button>
        <button className="btn primary" disabled={!dirtyCount} onClick={saveAll}>Save all ({dirtyCount})</button>
        <span className="muted small">Planned data last saved: {fmtStamp(lastSaved)}</span>
        <label className="fb-field push" title="Recorded in the activity log for every change you make">
          <span>Changed by</span>
          <input
            className="input"
            placeholder="your name"
            value={actor}
            onChange={(e) => {
              setActorState(e.target.value);
              setActor(e.target.value);
            }}
          />
        </label>
      </div>
      {status && <div className={`status ${status.tone}`}>{status.text}</div>}

      <datalist id="owner-options">
        {owners.map((o) => (
          <option key={o.username} value={o.username}>{`${o.display_name} | ${o.portfolio} | ${o.hosts} hosts`}</option>
        ))}
      </datalist>

      <div className="grid-wrap">
        <table className="table plan-grid">
          <thead>
            <tr>
              <th className="sticky c1">OS</th>
              <th className="sticky c2">Portfolio</th>
              <th>Application</th>
              <th>Owner</th>
              <th>Entry date</th>
              {config.months.map((m) => <th key={m} className="num">{fmtMonth(m)}</th>)}
              <th className="num">Total</th>
              <th>Last changed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.key} className={r.dirty ? "dirty" : ""}>
                <td className="sticky c1">
                  <select value={r.os} onChange={(e) => update(r.key, { os: e.target.value })}>
                    {config.tracked_os.map((o) => <option key={o}>{o}</option>)}
                  </select>
                </td>
                <td className="sticky c2">
                  <select
                    className={r.portfolio && !mapped.has(r.portfolio) ? "pf-unmapped" : ""}
                    value={r.portfolio}
                    onChange={(e) => update(r.key, { portfolio: e.target.value })}
                  >
                    <option value="">Select portfolio…</option>
                    {r.portfolio && !mapped.has(r.portfolio) && <option value={r.portfolio}>{r.portfolio} (unmapped)</option>}
                    {portfolios.map((p) => <option key={p.code} value={p.code}>{p.code}</option>)}
                  </select>
                </td>
                <td><input className="app-in" value={r.application} onChange={(e) => update(r.key, { application: e.target.value })} /></td>
                <td>
                  <input
                    list="owner-options"
                    className={r.owner && owners.length && !ownerSet.has(r.owner) ? "invalid" : ""}
                    title={r.owner && owners.length && !ownerSet.has(r.owner) ? "Not a known owner: this line won't join to any hosts" : ""}
                    value={r.owner}
                    onChange={(e) => update(r.key, { owner: e.target.value.trim() })}
                  />
                </td>
                <td><input type="date" value={r.entry_date} onChange={(e) => update(r.key, { entry_date: e.target.value })} /></td>
                {config.months.map((m) => (
                  <td key={m} className="num">
                    <input type="number" min={0} className="num-in" value={r.months[m] || ""} onChange={(e) => setMonth(r.key, m, e.target.value)} />
                  </td>
                ))}
                <td className="num"><b>{fmt(rowTotal(r))}</b></td>
                <td className="small">
                  {r.dirty ? <span className="tag warn">unsaved</span> : (
                    <>
                      <div>{r.last_changed_by || "-"}</div>
                      <div className="muted">{fmtStamp(r.last_changed_at)}</div>
                    </>
                  )}
                </td>
                <td className="actions">
                  <button className="btn small" disabled={!r.dirty} onClick={() => saveRow(r)}>Save</button>
                  <button className="btn small" onClick={() => addRow(r)} title="Duplicate">⧉</button>
                  <button className="btn small danger" onClick={() => removeRow(r)} title="Delete">✕</button>
                </td>
              </tr>
            ))}
            {!visible.length && (
              <tr><td colSpan={config.months.length + 8} className="muted">No plan lines yet. Add one or import a file.</td></tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td className="sticky c1" colSpan={1}><b>Total to decommission</b></td>
              <td className="sticky c2" />
              <td colSpan={3} />
              {monthTotals.map((t, i) => <td key={i} className="num"><b>{fmt(t)}</b></td>)}
              <td className="num"><b>{fmt(monthTotals.reduce((a, b) => a + b, 0))}</b></td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>

      <BulkImport onDone={async (text) => { await load(); after(text); }} />
      <ActivityLog refreshKey={logKey} />
    </div>
  );
}

// ------------------------------------------------------------------ stacked chart

type GroupBy = "portfolio" | "owner" | "application";

function PlanChart({ rows, months }: { rows: PlanLine[]; months: string[] }) {
  const [groupBy, setGroupBy] = usePersisted<GroupBy>("planned.groupBy", "portfolio");
  const { data, keys, ticks } = useMemo(() => {
    const totals = new Map<string, number>();
    const per = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const k = (r[groupBy] as string) || "(unassigned)";
      const bucket = per.get(k) ?? {};
      for (const m of months) bucket[m] = (bucket[m] ?? 0) + (r.months[m] || 0);
      per.set(k, bucket);
      totals.set(k, (totals.get(k) ?? 0) + rowTotal(r));
    }
    const ranked = [...totals.entries()].filter(([, t]) => t > 0).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const top = ranked.slice(0, 10);
    const rest = ranked.slice(10);
    const data = months.map((m) => {
      const d: Record<string, number | string> = { month: m };
      top.forEach((k) => (d[k] = per.get(k)![m]));
      if (rest.length) d.Other = rest.reduce((a, k) => a + per.get(k)![m], 0);
      return d;
    });
    const peak = Math.max(0, ...months.map((m) => rows.reduce((a, r) => a + (r.months[m] || 0), 0)));
    return { data, keys: rest.length ? [...top, "Other"] : top, ticks: niceTicks(peak) };
  }, [rows, months, groupBy]);

  return (
    <section className="card chart-card">
      <div className="chart-head">
        <h3>Planned decommissions / month</h3>
        <label className="fb-field">
          <span>Group by</span>
          <select className="fb-select" value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
            <option value="portfolio">Portfolio</option>
            <option value="owner">Owner</option>
            <option value="application">Application</option>
          </select>
        </label>
      </div>
      {keys.length ? (
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" />
            <XAxis dataKey="month" tickFormatter={fmtMonth} tick={{ fontSize: 12 }} />
            <YAxis domain={[0, ticks[ticks.length - 1]]} ticks={ticks} tickFormatter={fmtAxis} tick={{ fontSize: 12 }} width={48} />
            <Tooltip content={<ChartTooltip labelFormatter={fmtMonth} />} cursor={{ fill: "var(--hover)" }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {keys.map((k, i) => (
              <Bar key={k} dataKey={k} stackId="a" fill={k === "Other" ? OTHER_COLOR : PALETTE[i % PALETTE.length]} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <p className="muted">No plan data to chart yet.</p>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ import

function BulkImport({ onDone }: { onDone: (text: string) => Promise<void> }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    const f = fileRef.current?.files?.[0];
    if (!f) return setError("Choose a CSV or Excel file first.");
    setBusy(true);
    setError(null);
    try {
      const r = await api.importPlan(f);
      setResult(r);
      await onDone(`Imported ${f.name}: ${r.created} created, ${r.updated} updated, ${r.skipped} skipped.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card section">
      <h3>Bulk import</h3>
      <p className="muted small">
        CSV or Excel with columns OS, Portfolio, Application, Owner, Entry Date and one column per month (2026-06, Jun-2026
        and Jun '26 all work). Rows update in place when OS, Portfolio, Application and Owner match an existing line.
      </p>
      <div className="toolbar">
        <input ref={fileRef} type="file" accept=".csv,.tsv,.xlsx" />
        <button className="btn primary" disabled={busy} onClick={run}>{busy ? "Importing…" : "Import"}</button>
        <a className="btn" href={api.templateUrl}>Download template</a>
      </div>
      {error && <div className="status bad">{error}</div>}
      {result && (
        <div className="status ok">
          {result.created} created, {result.updated} updated, {result.skipped} skipped. Months found:{" "}
          {result.months_detected.map(fmtMonth).join(", ") || "none"}.
          {result.unmatched.length > 0 && (
            <div className="text-bad">
              Skipped unknown portfolios: {result.unmatched.map((u) => `${u.portfolio} (${u.rows})`).join(", ")}. Use a
              portfolio from the Mapping tab.
            </div>
          )}
          {result.unknown_owners.length > 0 && (
            <div className="text-warn">
              Owners not found in the CMDB (lines kept, but they won't join to hosts): {result.unknown_owners.join(", ")}.
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ audit

function describeChange(a: PlanAudit) {
  if (a.field === "line") return a.action === "delete" ? `deleted (${a.old_value})` : "line created";
  const field = a.field.startsWith("month:") ? fmtMonth(a.field.slice(6)) : a.field.replace("_", " ");
  return `${field}: ${a.old_value ?? "-"} → ${a.new_value ?? "-"}`;
}

function ActivityLog({ refreshKey }: { refreshKey: number }) {
  const [open, setOpen] = usePersisted<boolean>("planned.logOpen", false);
  const [action, setAction] = useState("");
  const [rows, setRows] = useState<PlanAudit[]>([]);

  useEffect(() => {
    if (open) api.audit(action || undefined).then(setRows).catch(() => setRows([]));
  }, [open, action, refreshKey]);

  return (
    <section className="card section">
      <button className="section-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        <h3>Activity log</h3>
        <span className="muted small">Every create, update, delete and import, with before and after values.</span>
      </button>
      {open && (
        <div className="section-body">
          <div className="toolbar">
            <label className="fb-field">
              <span>Action</span>
              <select className="fb-select" value={action} onChange={(e) => setAction(e.target.value)}>
                <option value="">All</option>
                <option value="create">Create</option>
                <option value="update">Update</option>
                <option value="delete">Delete</option>
                <option value="import">Import</option>
              </select>
            </label>
            <a className="btn" href={api.auditCsvUrl(action || undefined)}>⤓ Export CSV</a>
          </div>
          <div className="scroll-table">
            <table className="table compact">
              <thead>
                <tr><th>When</th><th>Action</th><th>OS</th><th>Portfolio</th><th>Owner</th><th>Change</th><th>By</th><th>Source</th></tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td className="nowrap">{fmtStamp(a.ts)}</td>
                    <td><span className={`tag act-${a.action}`}>{a.action}</span></td>
                    <td>{a.os}</td>
                    <td>{a.portfolio}</td>
                    <td>{a.owner || "-"}</td>
                    <td>{describeChange(a)}</td>
                    <td>{a.actor || "-"}</td>
                    <td className="small">{a.source}{a.detail ? ` | ${a.detail}` : ""}</td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={8} className="muted">No activity.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
