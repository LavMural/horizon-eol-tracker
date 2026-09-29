import { useEffect, useMemo, useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  api, type AppConfig, type BucketRow, type Decommissions, type SeriesByPortfolio, type SeriesPack,
  type SeriesTotal, type SummaryCard,
} from "../lib/api";
import { fmt, fmtAxis, fmtDate, fmtMonth, fmtSigned, niceMax, niceTicks } from "../lib/format";
import { usePersisted } from "../lib/hooks";
import { ChartHeader, ChartTooltip, PALETTE, SERIES } from "../components/charts";
import { MultiSelect } from "../components/MultiSelect";

interface OsData {
  total: SeriesTotal;
  byPf: SeriesByPortfolio;
}

export function InsightsTab({ config }: { config: AppConfig }) {
  const [cards, setCards] = useState<SummaryCard[]>([]);
  const [byOs, setByOs] = useState<Record<string, OsData>>({});
  const [unmatched, setUnmatched] = useState<{ os: string; portfolio: string; lines: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [os, setOs] = usePersisted<string>("insights.os", config.tracked_os[0]);
  const [savedSel, setSavedSel] = usePersisted<string[] | null>("insights.sel", null);

  useEffect(() => {
    const perOs = config.tracked_os.map((o) =>
      Promise.all([api.seriesTotal(o), api.seriesByPortfolio(o)]).then(
        ([total, byPf]) => [o, { total, byPf }] as const,
      ),
    );
    Promise.all([api.summary(), api.unmatchedPlans(), Promise.all(perOs)])
      .then(([s, u, entries]) => {
        setCards(s);
        setUnmatched(u);
        setByOs(Object.fromEntries(entries));
      })
      .catch((e) => setError(e.message));
  }, [config]);

  const data = byOs[os];
  // Portfolio options for the selected OS, largest baseline first.
  const options = useMemo(() => {
    if (!data) return [] as { pf: string; base: number }[];
    return Object.entries(data.byPf.portfolios)
      .map(([pf, p]) => ({ pf, base: p.baseline }))
      .filter((o) => o.base > 0)
      .sort((a, b) => b.base - a.base);
  }, [data]);
  const colorOf = (pf: string) => PALETTE[Math.max(0, options.findIndex((o) => o.pf === pf)) % PALETTE.length];
  const selected = savedSel ? savedSel.filter((s) => options.some((o) => o.pf === s)) : options.map((o) => o.pf);
  const allSelected = selected.length === options.length;

  const sharedYMax = useMemo(() => {
    let m = 0;
    Object.values(byOs).forEach(({ total }) => {
      m = Math.max(m, total.baseline, ...Object.values(total.planned_remaining));
    });
    return niceMax(m);
  }, [byOs]);

  if (error) return <div className="notice bad">{error}</div>;
  if (!cards.length || !data) return <div className="loading">Loading insights…</div>;

  const windowEnd = config.months[config.months.length - 1];

  return (
    <div className="insights">
      <div className="cards">
        {cards.map((c) => (
          <OsCard key={c.os} card={c} windowEnd={windowEnd} active={c.os === os} onSelect={() => setOs(c.os)} />
        ))}
      </div>

      <div className="filterbar">
        <label className="fb-field">
          <span>OS</span>
          <select
            className="fb-select"
            value={os}
            onChange={(e) => {
              setOs(e.target.value);
              setSavedSel(null);
            }}
          >
            {config.tracked_os.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </label>
        <label className="fb-field">
          <span>Portfolios</span>
          <MultiSelect
            noun="portfolios"
            allLabel="All portfolios"
            options={options.map((o) => ({ value: o.pf, hint: fmt(o.base), color: colorOf(o.pf) }))}
            selected={selected}
            onChange={(next) => setSavedSel(next.length === options.length ? null : next)}
          />
        </label>
      </div>

      <div className="pf-selected">
        {allSelected ? (
          <span className="chip chip-all">All portfolios ({options.length})</span>
        ) : (
          <>
            {selected.map((pf) => (
              <span key={pf} className="chip" style={{ borderColor: colorOf(pf), color: colorOf(pf) }}>
                {pf}
                <button className="chip-x" aria-label={`Remove ${pf}`} onClick={() => setSavedSel(selected.filter((s) => s !== pf))}>
                  ×
                </button>
              </span>
            ))}
            <button className="clear-chip" onClick={() => setSavedSel(null)}>
              Reset to all
            </button>
          </>
        )}
      </div>

      {unmatched.length > 0 && (
        <div className="notice warn">
          Some plan lines use a portfolio that doesn't match the actuals and won't be counted:{" "}
          {unmatched.map((u) => `${u.portfolio} (${u.os}, ${u.lines})`).join(", ")}.
        </div>
      )}

      <Charts
        os={os}
        config={config}
        data={data}
        selected={selected}
        allSelected={allSelected}
        yMax={sharedYMax}
      />
    </div>
  );
}

// ------------------------------------------------------------------ summary card

function OsCard({ card: c, windowEnd, active, onSelect }: {
  card: SummaryCard;
  windowEnd: string;
  active: boolean;
  onSelect: () => void;
}) {
  const atRisk = !c.projected_completion || c.projected_completion > windowEnd;
  return (
    <section className={active ? "card os-card active" : "card os-card"}>
      <div className="os-card-head">
        <h2>
          <button className="linklike" onClick={onSelect} title="Show this OS in the charts below">
            {c.os}
          </button>
        </h2>
        <span className={atRisk ? "status-tag bad" : "status-tag ok"}>
          {atRisk ? "At risk" : "On track to finish"}
        </span>
      </div>
      <div className="kpis">
        <Kpi label="Current remaining" value={fmt(c.current_remaining)} big />
        <Kpi label={`Baseline (${fmtDate(c.baseline_date).replace(/, \d{4}$/, "")})`} value={fmt(c.baseline)} />
        <Kpi label="Net change (last refresh)" value={fmtSigned(c.net_change)} />
        <Kpi label="Flagged hosts" value={fmt(c.data_quality_flags)} />
      </div>
      <div className="progress-row">
        <div className="progress" aria-label={`${c.pct_complete}% complete`}>
          <div style={{ width: `${Math.min(100, c.pct_complete)}%` }} />
        </div>
        <b>{c.pct_complete}% complete</b>
      </div>
      <div className="muted small">
        Run rate {fmt(c.run_rate_per_month)} hosts/month (last 90 days) | projected completion{" "}
        <b className={atRisk ? "text-bad" : "text-ok"}>{fmtMonth(c.projected_completion)}</b> vs target{" "}
        {fmtMonth(windowEnd)}
      </div>
      <div className="badges">
        <BadgeTip kind="on_track" count={c.on_track_hosts} rows={c.on_track_list} checkpoint={c.checkpoint_month} />
        <BadgeTip kind="behind" count={c.behind_hosts} rows={c.behind_list} checkpoint={c.checkpoint_month} />
        <BadgeTip kind="no_plan" count={c.no_plan_hosts} rows={c.no_plan_list} checkpoint={c.checkpoint_month} />
      </div>
    </section>
  );
}

function Kpi({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div className={big ? "kpi kpi-big" : "kpi"}>
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
    </div>
  );
}

const BADGE = {
  on_track: { cls: "ok", label: "on track", title: "On track | remaining hosts by portfolio" },
  behind: { cls: "bad", label: "behind", title: "Behind | remaining hosts by portfolio" },
  no_plan: { cls: "warn", label: "no plan", title: "No plan | remaining hosts by portfolio" },
} as const;

function defsFor(kind: keyof typeof BADGE, checkpoint: string | null) {
  const due = checkpoint ? `through ${fmtMonth(checkpoint)}` : "so far";
  const common = { term: "left", desc: "hosts this owner still has on the EOL OS" };
  if (kind === "on_track")
    return [common, { term: "plan", desc: `total hosts in the owner's plan; on track means they've met every month due ${due}` }];
  if (kind === "behind")
    return [
      common,
      { term: "over", desc: `hosts above where the plan says they should be ${due}` },
      { term: "plan", desc: "total hosts in the owner's plan" },
    ];
  return [{ term: "hosts", desc: "remaining hosts whose owner has no plan line for this OS and portfolio" }];
}

function BadgeTip({ kind, count, rows, checkpoint }: {
  kind: keyof typeof BADGE;
  count: number;
  rows: BucketRow[];
  checkpoint: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState(false);
  const b = BADGE[kind];
  return (
    <span className="badge-tip" onMouseEnter={() => setOpen(true)} onMouseLeave={() => { setOpen(false); setInfo(false); }}>
      <button className={`badge ${b.cls}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        <b>{fmt(count)}</b> {b.label}
      </button>
      {open && rows.length > 0 && (
        <>
          <span className="bp-bridge" />
          <div className="badge-pop" role="dialog">
            <div className="badge-pop-title">
              <span>{b.title}</span>
              <span
                className={info ? "bp-info on" : "bp-info"}
                role="button"
                tabIndex={0}
                aria-expanded={info}
                aria-label="What do these numbers mean?"
                onClick={() => setInfo(!info)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setInfo(!info)}
              >
                ?
              </span>
            </div>
            {info && (
              <div className="bp-info-pop">
                {defsFor(kind, checkpoint).map((d) => (
                  <div key={d.term} className="bp-def">
                    <b>{d.term}</b>: {d.desc}
                  </div>
                ))}
              </div>
            )}
            <div className="bp-hint muted small">Click a portfolio to see its owners.</div>
            <ul className="bp-list">
              {rows.map((r) => (
                <PortfolioRow key={r.portfolio} row={r} kind={kind} />
              ))}
            </ul>
          </div>
        </>
      )}
    </span>
  );
}

function PortfolioRow({ row, kind }: { row: BucketRow; kind: keyof typeof BADGE }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button className="bp-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span className="bp-name">{row.portfolio}</span>
        <span className="bp-val">{fmt(row.hosts)} hosts</span>
      </button>
      {open && (
        <ul className="own-list">
          {row.owners.map((o) => (
            <li key={o.username}>
              <span className="own-name">{o.username}</span>
              <span className="own-val">
                {kind === "on_track" && <>✅ {fmt(o.hosts)} left · plan {fmt(o.planned_total)}</>}
                {kind === "behind" && <>⚠ {fmt(o.hosts)} left · over {fmt(o.over)} · plan {fmt(o.planned_total)}</>}
                {kind === "no_plan" && <>❌ {fmt(o.hosts)} hosts · no plan</>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

// ------------------------------------------------------------------ charts

function sumPacks(packs: SeriesPack[], months: string[]): SeriesPack {
  const zero = () => Object.fromEntries(months.map((m) => [m, 0])) as Record<string, number>;
  const out: SeriesPack = { baseline: 0, planned_decom: zero(), planned_remaining: zero(), actual_remaining: zero(), actual_decom: zero() };
  for (const p of packs) {
    out.baseline += p.baseline;
    for (const m of months) {
      out.planned_decom[m] += p.planned_decom[m] ?? 0;
      out.planned_remaining[m] += p.planned_remaining[m] ?? 0;
      for (const k of ["actual_remaining", "actual_decom"] as const) {
        const v = p[k][m];
        out[k][m] = v == null || out[k][m] == null ? null : (out[k][m] as number) + v;
      }
    }
  }
  return out;
}

function Charts({ os, config, data, selected, allSelected, yMax }: {
  os: string;
  config: AppConfig;
  data: OsData;
  selected: string[];
  allSelected: boolean;
  yMax: number;
}) {
  const [drillMonth, setDrillMonth] = useState<string | null>(null);
  const [drill, setDrill] = useState<Decommissions | null>(null);
  const months = config.months;

  useEffect(() => setDrillMonth(null), [os]);
  useEffect(() => {
    setDrill(null);
    if (drillMonth) api.decommissions(os, drillMonth).then(setDrill).catch(() => setDrill(null));
  }, [os, drillMonth]);

  // All portfolios: use the OS total (the CMDB daily count). A subset: sum its portfolios.
  const pack: SeriesPack = allSelected
    ? data.total
    : sumPacks(selected.map((pf) => data.byPf.portfolios[pf]).filter(Boolean), months);

  const burndown = months.map((m) => ({
    month: m,
    Planned: pack.planned_remaining[m],
    Actual: m <= config.current_month ? pack.actual_remaining[m] : null,
  }));
  const pva = months.map((m) => ({ month: m, Planned: pack.planned_decom[m], Actual: pack.actual_decom[m] }));
  const pvaTicks = niceTicks(Math.max(0, ...pva.flatMap((d) => [d.Planned ?? 0, d.Actual ?? 0])));
  const scope = allSelected ? "All Portfolios" : selected.join(", ") || "No portfolios selected";
  const drillRows = drill ? drill.hosts.filter((h) => selected.includes(h.portfolio)) : [];

  return (
    <div className="chart-grid">
      <section className="card chart-card">
        <ChartHeader title="Burndown" source={config.source} scope={scope} />
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={burndown} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" />
            <XAxis dataKey="month" tickFormatter={fmtMonth} tick={{ fontSize: 12 }} />
            <YAxis domain={allSelected ? [0, yMax] : [0, "auto"]} tickFormatter={fmtAxis} allowDecimals={false} tick={{ fontSize: 12 }} width={48} />
            <Tooltip content={<ChartTooltip labelFormatter={fmtMonth} />} />
            <Legend />
            <ReferenceLine y={0} stroke="var(--bad)" strokeDasharray="4 4" label={{ value: "EOL target", position: "insideBottomLeft", fontSize: 11, fill: "var(--bad)" }} />
            <Line type="monotone" dataKey="Planned" stroke={SERIES.planned} strokeDasharray="6 4" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="Actual" stroke={SERIES.actual} strokeWidth={2.5} connectNulls dot={{ r: 3 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
        <p className="muted small">Remaining hosts at month end. Planned = baseline minus cumulative planned decommissions.</p>
      </section>

      <section className="card chart-card">
        <ChartHeader title="Planned v Actual" source={config.source} scope={scope} />
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={pva} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" />
            <XAxis dataKey="month" tickFormatter={fmtMonth} tick={{ fontSize: 12 }} />
            <YAxis domain={[0, pvaTicks[pvaTicks.length - 1]]} ticks={pvaTicks} tickFormatter={fmtAxis} tick={{ fontSize: 12 }} width={48} />
            <Tooltip content={<ChartTooltip labelFormatter={fmtMonth} />} cursor={{ fill: "var(--hover)" }} />
            <Legend />
            <Bar dataKey="Planned" fill={SERIES.planned} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            <Bar
              dataKey="Actual"
              fill={SERIES.actual}
              radius={[3, 3, 0, 0]}
              cursor="pointer"
              isAnimationActive={false}
              onClick={(d: { payload?: { month?: string } }) => d?.payload?.month && setDrillMonth(d.payload.month)}
            />
          </BarChart>
        </ResponsiveContainer>
        <p className="muted small">💡 Click an Actual bar to list the hosts that left {os} that month.</p>
      </section>

      {drillMonth && (
        <section className="card drill">
          <div className="drill-head">
            <h3>
              Hosts that left {os} | {fmtMonth(drillMonth)}{" "}
              <span className="muted">({drill ? fmt(drillRows.length) : "…"} hosts)</span>
            </h3>
            <button className="btn" onClick={() => setDrillMonth(null)}>Clear</button>
          </div>
          <p className="muted small">
            Baseline hosts that were decommissioned or upgraded to another OS during the month, limited to the selected
            portfolios.
          </p>
          <div className="scroll-table">
            <table className="table compact">
              <thead>
                <tr><th>Hostname</th><th>Portfolio</th><th>Now on</th><th>Left on</th><th>Status</th></tr>
              </thead>
              <tbody>
                {drillRows.map((h) => (
                  <tr key={h.hostname}>
                    <td className="mono">{h.hostname}</td>
                    <td>{h.portfolio}</td>
                    <td>{h.os}</td>
                    <td>{fmtDate(h.left_date)}</td>
                    <td><span className={h.status === "upgraded" ? "tag ok" : "tag"}>{h.status}</span></td>
                  </tr>
                ))}
                {drill && drillRows.length === 0 && (
                  <tr><td colSpan={5} className="muted">No hosts left in this month for the selected portfolios.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
