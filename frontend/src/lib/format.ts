// Number, date and CSV helpers.

export const fmt = (n: number | null | undefined) => (n == null ? "-" : n.toLocaleString("en-US"));

export const fmtSigned = (n: number) => (n > 0 ? `+${fmt(n)}` : fmt(n));

export const fmtAxis = (n: number) =>
  Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(Math.abs(n) >= 10000 ? 0 : 1).replace(/\.0$/, "")}k` : `${n}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09" -> "Sep '26" */
export const fmtMonth = (m: string | null | undefined) => {
  if (!m) return "-";
  const [y, mm] = m.split("-");
  return `${MONTHS[Number(mm) - 1]} '${y.slice(2)}`;
};

/** "2026-09-15" -> "Sep 15, 2026" */
export const fmtDate = (d: string | null | undefined) => {
  if (!d) return "-";
  const [y, m, day] = d.slice(0, 10).split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(day)}, ${y}`;
};

/**
 * Server timestamps are UTC without a zone designator. Parse them as UTC and show them
 * in the viewer's local time zone, e.g. "Sep 15, 2026, 6:00 AM PDT".
 */
export function fmtStamp(s: string | null | undefined): string {
  if (!s) return "-";
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function downloadCsv(filename: string, header: string[], rows: (string | number | null)[][]) {
  const esc = (v: string | number | null) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Round up to a clean axis maximum (1, 2, 2.5, 5 or 10 x 10^n). */
export function niceMax(v: number): number {
  if (v <= 0) return 10;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}
