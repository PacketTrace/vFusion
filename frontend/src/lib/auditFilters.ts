/**
 * The one description of "which slice of the audit log am I looking at".
 *
 * It lives in the URL. That is what lets a bar on the Insights tab be a
 * plain link into the list, a filtered view survive a refresh, and a
 * "look at this" be pasted to someone else. Every list value is
 * multi-select; the scalar ones (user, ip, device) are a single match.
 */

export type AuditRange = "1h" | "6h" | "24h" | "7d" | "30d" | "all" | "custom";

export interface AuditFilters {
  q: string;
  range: AuditRange;
  since: string | null;
  until: string | null;
  category: string[];
  event_name: string[];
  actor: string[];
  user: string;
  ip: string;
  api_key: string[];
  method: string[];
  status: string[];
  url: string;
  device_type: string[];
  device_id: string;
  device: string;
  site: string[];
  include_self: boolean;
}

export const LIST_KEYS = [
  "category",
  "event_name",
  "actor",
  "api_key",
  "method",
  "status",
  "device_type",
  "site",
] as const;
export type ListKey = (typeof LIST_KEYS)[number];

export const SCALAR_KEYS = ["user", "ip", "url", "device_id", "device"] as const;
export type ScalarKey = (typeof SCALAR_KEYS)[number];

export const RANGES: Array<{ key: AuditRange; label: string; ms: number | null }> = [
  { key: "1h", label: "Last hour", ms: 3600_000 },
  { key: "6h", label: "Last 6 hours", ms: 6 * 3600_000 },
  { key: "24h", label: "Last 24 hours", ms: 24 * 3600_000 },
  { key: "7d", label: "Last 7 days", ms: 7 * 86400_000 },
  { key: "30d", label: "Last 30 days", ms: 30 * 86400_000 },
  { key: "all", label: "Everything", ms: null },
];

export const DEFAULT_FILTERS: AuditFilters = {
  q: "",
  range: "24h",
  since: null,
  until: null,
  category: [],
  event_name: [],
  actor: [],
  user: "",
  ip: "",
  api_key: [],
  method: [],
  status: [],
  url: "",
  device_type: [],
  device_id: "",
  device: "",
  site: [],
  include_self: false,
};

// Keys that are not filters but share the URL (the Explorer tab, a
// selected row). Left alone by everything below.
const PASSTHROUGH = new Set(["tab", "event"]);

export function filtersFromSearch(sp: URLSearchParams): AuditFilters {
  const f: AuditFilters = { ...DEFAULT_FILTERS };
  f.q = sp.get("q") ?? "";
  const range = sp.get("range") as AuditRange | null;
  if (range && RANGES.some((r) => r.key === range)) f.range = range;
  if (sp.get("since") || sp.get("until")) {
    f.range = "custom";
    f.since = sp.get("since");
    f.until = sp.get("until");
  }
  for (const k of LIST_KEYS) f[k] = sp.getAll(k).filter(Boolean);
  for (const k of SCALAR_KEYS) f[k] = sp.get(k) ?? "";
  f.include_self = sp.get("self") === "1";
  return f;
}

/** Write the filters back to the URL, keeping the passthrough keys. */
export function filtersToSearch(f: AuditFilters, current: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of current.entries()) if (PASSTHROUGH.has(k)) out.append(k, v);
  if (f.q) out.set("q", f.q);
  if (f.range === "custom") {
    if (f.since) out.set("since", f.since);
    if (f.until) out.set("until", f.until);
  } else if (f.range !== DEFAULT_FILTERS.range) {
    out.set("range", f.range);
  }
  for (const k of LIST_KEYS) for (const v of f[k]) out.append(k, v);
  for (const k of SCALAR_KEYS) if (f[k]) out.set(k, f[k]);
  if (f.include_self) out.set("self", "1");
  return out;
}

/** Resolve the time window. Presets are re-evaluated on every call so a
 *  ten-second refetch of "last hour" is actually the last hour. */
export function windowFor(f: AuditFilters, now = Date.now()): { since: string; until: string } {
  if (f.range === "custom" && (f.since || f.until)) {
    const until = f.until ?? new Date(now).toISOString();
    const since = f.since ?? new Date(new Date(until).getTime() - 24 * 3600_000).toISOString();
    return { since, until };
  }
  const preset = RANGES.find((r) => r.key === f.range) ?? RANGES[2];
  const until = new Date(now).toISOString();
  const since =
    preset.ms === null ? "2000-01-01T00:00:00Z" : new Date(now - preset.ms).toISOString();
  return { since, until };
}

/** The query string the backend wants. */
export function filtersToApiParams(f: AuditFilters, now = Date.now()): URLSearchParams {
  const p = new URLSearchParams();
  const { since, until } = windowFor(f, now);
  p.set("since", since);
  p.set("until", until);
  if (f.q) p.set("q", f.q);
  for (const k of LIST_KEYS) for (const v of f[k]) p.append(k, v);
  for (const k of SCALAR_KEYS) if (f[k]) p.set(k, f[k]);
  if (f.include_self) p.set("include_self", "true");
  return p;
}

/** A stable key for react-query: same filters → same string. */
export function filtersKey(f: AuditFilters): string {
  return filtersToSearch(f, new URLSearchParams()).toString();
}

export function toggleListValue(f: AuditFilters, key: ListKey, value: string): AuditFilters {
  const has = f[key].includes(value);
  return { ...f, [key]: has ? f[key].filter((v) => v !== value) : [...f[key], value] };
}

export function setScalar(f: AuditFilters, key: ScalarKey, value: string): AuditFilters {
  return { ...f, [key]: f[key] === value ? "" : value };
}

export function activeCount(f: AuditFilters): number {
  let n = 0;
  if (f.q) n++;
  for (const k of LIST_KEYS) n += f[k].length;
  for (const k of SCALAR_KEYS) if (f[k]) n++;
  return n;
}

export function clearAll(f: AuditFilters): AuditFilters {
  return { ...DEFAULT_FILTERS, range: f.range, since: f.since, until: f.until, include_self: f.include_self };
}

/** Category display: label + a fixed colour slot. Colour follows the
 *  category, never its rank, so a filter that removes a series does not
 *  repaint the survivors. Eight slots are the ceiling for telling series
 *  apart; the rest share the neutral. */
export const CATEGORY_LABEL: Record<string, string> = {
  api: "API requests",
  users: "User management",
  admin: "Admin",
  support: "Verkada Support",
  devices: "Device management",
  cameras: "Cameras",
  access: "Access control",
  sensors: "Sensors",
  alarms: "Alarms",
  intercoms: "Intercoms",
  workplace: "Workplace",
  gateway: "Gateway",
  integrations: "Integrations",
  other: "Other",
};

// Validated (dataviz validator, dark surface): adjacent CVD ΔE ≥ 8.4,
// normal-vision ΔE ≥ 19.3, all ≥ 3:1 on the surface.
export const CATEGORY_COLOR: Record<string, string> = {
  api: "#3987e5",
  cameras: "#199e70",
  access: "#9085e9",
  users: "#d95926",
  admin: "#c98500",
  sensors: "#d55181",
  integrations: "#008300",
  alarms: "#e66767",
};
export const NEUTRAL_SERIES = "#6b7280";

export function categoryColor(cat: string): string {
  return CATEGORY_COLOR[cat] ?? NEUTRAL_SERIES;
}

export const ACTOR_LABEL: Record<string, string> = {
  user: "Signed-in user",
  api_key: "API key",
  support: "Verkada Support",
  system: "System",
};
