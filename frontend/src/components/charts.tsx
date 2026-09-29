import type { ReactNode } from "react";
import { fmt } from "../lib/format";

// Categorical palette for portfolio series (ordered for contrast between neighbours).
export const PALETTE = [
  "#3b5bdb", "#0ca678", "#f59f00", "#e8590c", "#7048e8", "#1098ad", "#d6336c",
  "#5c940d", "#364fc7", "#c2255c", "#087f5b", "#9c36b5", "#e67700", "#495057",
];
export const OTHER_COLOR = "#adb5bd";

export const SERIES = {
  planned: "#94a3b8",
  actual: "#3b5bdb",
  baseline: "#64748b",
};

interface TooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: { name: string; value: number | null; color: string }[];
  labelFormatter?: (l: string) => string;
}

/** Tooltip used by every chart: formatted numbers, null series hidden. */
export function ChartTooltip({ active, label, payload, labelFormatter }: TooltipProps) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter((p) => p.value != null);
  if (!rows.length) return null;
  return (
    <div className="chart-tip">
      <div className="chart-tip-label">{labelFormatter ? labelFormatter(String(label)) : label}</div>
      {rows.map((p) => (
        <div key={p.name} className="chart-tip-row">
          <span className="swatch" style={{ background: p.color }} />
          <span>{p.name}</span>
          <b>{fmt(p.value)}</b>
        </div>
      ))}
    </div>
  );
}

/** Chart banner: title on the left, source and portfolio scope on the right. */
export function ChartHeader({ title, source, scope, extra }: {
  title: string;
  source: string;
  scope: string;
  extra?: ReactNode;
}) {
  return (
    <div className="chart-head">
      <div>
        <h3>{title}</h3>
        {extra}
      </div>
      <div className="chart-meta">
        <div>
          <span className="muted">Source:</span> <b>{source.toUpperCase()}</b>
        </div>
        <div className="chart-scope" title={scope}>{scope}</div>
      </div>
    </div>
  );
}
