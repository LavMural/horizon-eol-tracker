// Typed client for the Horizon API.

export type MonthMap<T = number> = Record<string, T>;

export interface Meta {
  app_name: string;
  tagline: string;
  source: string;
  dataset: string | null;
  last_refresh: string | null;
  as_of: string;
  planned_last_saved: string | null;
}

export interface AppConfig {
  tracked_os: string[];
  months: string[];
  baseline_date: string;
  as_of: string;
  current_month: string;
  checkpoint_month: string | null;
  source: string;
  unknown_bucket: string;
}

export interface OwnerStat {
  username: string;
  hosts: number;
  planned_total: number;
  over: number;
}

export interface BucketRow {
  portfolio: string;
  hosts: number;
  owners: OwnerStat[];
}

export interface SummaryCard {
  os: string;
  baseline_date: string;
  baseline: number;
  current_remaining: number;
  pct_complete: number;
  net_change: number;
  run_rate_per_month: number;
  projected_completion: string | null;
  data_quality_flags: number;
  current_month: string;
  checkpoint_month: string | null;
  on_track_hosts: number;
  behind_hosts: number;
  no_plan_hosts: number;
  remaining_snapshot: number;
  on_track_list: BucketRow[];
  behind_list: BucketRow[];
  no_plan_list: BucketRow[];
}

export interface SeriesPack {
  baseline: number;
  planned_decom: MonthMap;
  planned_remaining: MonthMap;
  actual_remaining: MonthMap<number | null>;
  actual_decom: MonthMap<number | null>;
}

export interface SeriesTotal extends SeriesPack {
  os: string;
  months: string[];
}

export interface SeriesByPortfolio {
  os: string;
  months: string[];
  portfolios: Record<string, SeriesPack>;
}

export interface DecomHost {
  hostname: string;
  portfolio: string;
  os: string;
  left_date: string;
  month: string;
  status: "upgraded" | "decommissioned";
}

export interface Decommissions {
  os: string;
  month: string | null;
  count: number;
  hosts: DecomHost[];
}

export interface PlanLine {
  id: number | null;
  os: string;
  portfolio: string;
  application: string;
  owner: string;
  entry_date: string;
  updated_at?: string | null;
  months: MonthMap;
  last_changed_by?: string | null;
  last_changed_at?: string | null;
}

export interface PlanAudit {
  id: number;
  ts: string;
  action: string;
  os: string | null;
  portfolio: string | null;
  application: string | null;
  owner: string | null;
  field: string;
  old_value: string | null;
  new_value: string | null;
  actor: string | null;
  source: string;
  detail: string | null;
  plan_line_id: number | null;
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  months_detected: string[];
  unmatched: { portfolio: string; rows: number }[];
  unknown_owners: string[];
}

export interface QualityOs {
  os: string;
  remaining: number;
  flags: { unmapped: number; unowned: number; departed: number; remediated: number };
  portfolios: { portfolio: string; full_name: string; hosts: number; owners: number }[];
}

export interface FlaggedHost {
  hostname: string;
  os: string;
  current_os: string | null;
  host_type: string;
  portfolio: string;
  owner: string;
  owner_status: string;
  flags: string[];
}

export interface TriageRow {
  owner: string;
  display_name: string;
  status: string;
  first_seen: string | null;
  hosts: number;
  os: Record<string, number>;
  portfolio: string;
  reasons: string[];
  assignable: boolean;
}

export interface OwnerOption {
  username: string;
  display_name: string;
  hosts: number;
  portfolio: string;
}

export interface PortfolioInfo {
  code: string;
  full_name: string;
  origin: "mapping" | "feed" | "system";
  mapped_owners: number;
  remaining: Record<string, number>;
}

export interface OwnerMapRow {
  owner: string;
  display_name: string;
  portfolio: string;
  updated_at: string | null;
}

export interface OwnerStatusRow {
  username: string;
  display_name: string;
  status: string;
  first_seen: string;
  note: string | null;
}

// ------------------------------------------------------------------ identity

const ACTOR_KEY = "planned.actor";

export function getActor(): string {
  try {
    return localStorage.getItem(ACTOR_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setActor(v: string) {
  try {
    localStorage.setItem(ACTOR_KEY, v);
  } catch {
    /* storage unavailable: identity just isn't remembered */
  }
}

// ------------------------------------------------------------------ transport

const STATUS_LABEL: Record<number, string> = {
  400: "Bad request",
  404: "Not found",
  409: "Conflict",
  422: "Validation error",
  500: "Server error",
};

function humanizeDetail(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail))
    return detail
      .map((d) => `${(d.loc ?? []).filter((x: unknown) => x !== "body").join(".")}: ${d.msg}`)
      .join("; ");
  return JSON.stringify(detail);
}

async function req<T>(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
  const write = init.method && init.method !== "GET";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? (write ? 60000 : 20000));
  const headers = new Headers(init.headers);
  const actor = getActor();
  if (actor) headers.set("X-Changed-By", actor);
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, signal: ctrl.signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error("Timeout: the server took too long to respond.");
    throw new Error("Network error: could not reach the server.");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = humanizeDetail((await res.json()).detail);
    } catch {
      /* not JSON */
    }
    throw new Error(`${res.status} ${STATUS_LABEL[res.status] ?? "Error"}: ${msg}`);
  }
  return res.json() as Promise<T>;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const q = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => v !== undefined && v !== "" && s.set(k, v));
  const str = s.toString();
  return str ? `?${str}` : "";
};

export const api = {
  meta: () => req<Meta>("/api/meta"),
  config: () => req<AppConfig>("/api/config"),
  resetDemo: () => req<{ reset: boolean }>("/api/demo/reset", { method: "POST" }),

  summary: () => req<SummaryCard[]>("/api/insights/summary"),
  seriesTotal: (os: string) => req<SeriesTotal>(`/api/insights/series${q({ os, by: "total" })}`),
  seriesByPortfolio: (os: string) => req<SeriesByPortfolio>(`/api/insights/series${q({ os, by: "portfolio" })}`),
  decommissions: (os: string, month?: string) =>
    req<Decommissions>(`/api/insights/decommissions${q({ os, month })}`),

  planned: () => req<PlanLine[]>("/api/planned"),
  createPlan: (l: PlanLine) => req<PlanLine>("/api/planned", json("POST", l)),
  updatePlan: (l: PlanLine) => req<PlanLine>(`/api/planned/${l.id}`, json("PUT", l)),
  deletePlan: (id: number) => req<{ deleted: number }>(`/api/planned/${id}`, { method: "DELETE" }),
  importPlan: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return req<ImportResult>("/api/planned/import", { method: "POST", body: fd });
  },
  unmatchedPlans: () => req<{ os: string; portfolio: string; lines: number }[]>("/api/planned/unmatched"),
  audit: (action?: string) => req<PlanAudit[]>(`/api/planned/audit${q({ action, limit: "500" })}`),
  auditCsvUrl: (action?: string) => `/api/planned/audit.csv${q({ action })}`,
  templateUrl: "/api/planned/template",

  quality: () => req<QualityOs[]>("/api/actuals/quality"),
  flagged: (os: string[]) =>
    req<{ as_of: string; count: number; hosts: FlaggedHost[] }>(
      `/api/actuals/flagged?${os.map((o) => `os=${encodeURIComponent(o)}`).join("&")}`,
    ),
  triage: () => req<TriageRow[]>("/api/actuals/triage"),
  owners: () => req<OwnerOption[]>("/api/actuals/owners"),
  snapshots: () => req<{ date: string; counts: Record<string, number> }[]>("/api/actuals/snapshots"),

  portfolios: () => req<PortfolioInfo[]>("/api/mapping/portfolios"),
  ownerMap: () => req<OwnerMapRow[]>("/api/mapping/owner-map"),
  setOwnerMap: (owner: string, portfolio: string) =>
    req<{ hosts_updated: number }>("/api/mapping/owner-map", json("POST", { owner, portfolio })),
  deleteOwnerMap: (owner: string) =>
    req<{ hosts_updated: number }>(`/api/mapping/owner-map/${encodeURIComponent(owner)}`, { method: "DELETE" }),
  ownerStatus: () => req<OwnerStatusRow[]>("/api/mapping/owners"),
  setOwnerStatus: (username: string, status: string, note: string | null) =>
    req<unknown>(`/api/mapping/owners/${encodeURIComponent(username)}`, json("PUT", { status, note })),
};
