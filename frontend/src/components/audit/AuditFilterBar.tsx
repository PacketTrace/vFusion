import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { API_BASE, AuditStatus, apiPost } from "../../lib/api";
import {
  AuditFilters,
  RANGES,
  activeCount,
  clearAll,
  filtersToApiParams,
  LIST_KEYS,
  SCALAR_KEYS,
  CATEGORY_LABEL,
  ACTOR_LABEL,
} from "../../lib/auditFilters";
import { fmtDuration, fmtNum, fmtRel } from "../../lib/format";

/**
 * The row above both audit tabs: search, time range, the self-traffic
 * toggle, the poll status, and export. Filters are URL state (see
 * useAuditFilters); this component only edits them.
 */
export default function AuditFilterBar({
  filters,
  setFilters,
  status,
  selfHidden,
  total,
}: {
  filters: AuditFilters;
  setFilters: (f: AuditFilters | ((p: AuditFilters) => AuditFilters)) => void;
  status: AuditStatus | undefined;
  selfHidden: number | undefined;
  total: number | undefined;
}) {
  // Debounced locally so the URL (and the queries behind it) change
  // once per pause, not once per keystroke.
  const [q, setQ] = useState(filters.q);
  useEffect(() => setQ(filters.q), [filters.q]);
  useEffect(() => {
    if (q === filters.q) return;
    const t = setTimeout(() => setFilters((f) => ({ ...f, q })), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const qc = useQueryClient();
  const backfill = useMutation({
    mutationFn: (days: number) => apiPost<AuditStatus>("/api/audit-events/backfill", { days }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["audit-status"] }),
  });

  const exportHref = `${API_BASE}/api/audit-events/export?${filtersToApiParams(filters).toString()}`;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="relative flex-1 min-w-[14rem] max-w-md">
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search users, IPs, devices, endpoints, event details…"
          className="w-full px-3 py-1.5 rounded-md bg-white/5 border border-white/15 text-sm focus:outline-none focus:border-sky-600"
          data-testid="audit-search"
        />
        {q && (
          <button
            type="button"
            onClick={() => setQ("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-200 text-sm"
            aria-label="clear search"
          >
            ×
          </button>
        )}
      </div>

      <select
        value={filters.range}
        onChange={(e) =>
          setFilters((f) => ({
            ...f,
            range: e.target.value as AuditFilters["range"],
            since: null,
            until: null,
          }))
        }
        className="px-3 py-1.5 rounded-md bg-white/5 border border-white/15 text-sm focus:outline-none focus:border-sky-600"
        aria-label="time range"
      >
        {RANGES.map((r) => (
          <option key={r.key} value={r.key}>
            {r.label}
          </option>
        ))}
        {filters.range === "custom" && <option value="custom">Custom window</option>}
      </select>

      <button
        type="button"
        onClick={() => setFilters((f) => ({ ...f, include_self: !f.include_self }))}
        className={`text-xs px-2.5 py-1.5 rounded-md border transition-colors ${
          filters.include_self
            ? "border-sky-600 bg-sky-950/40 text-sky-200"
            : "border-white/15 text-slate-300 hover:bg-white/10"
        }`}
        title={
          filters.include_self
            ? "Requests made with this install's own Verkada key are included"
            : "Requests made with this install's own Verkada key are hidden — they are most of the log and rarely the question"
        }
        aria-pressed={filters.include_self}
      >
        {filters.include_self ? "Showing own API calls" : "Own API calls hidden"}
        {!filters.include_self && selfHidden !== undefined && selfHidden > 0 && (
          <span className="ml-1 text-slate-500">({fmtNum(selfHidden)})</span>
        )}
      </button>

      <span className="text-xs text-slate-500">
        {total !== undefined ? `${fmtNum(total)} match${total === 1 ? "" : "es"}` : ""}
      </span>

      <div className="ml-auto flex items-center gap-2">
        <PollPill status={status} />
        <select
          value=""
          onChange={(e) => {
            const d = Number(e.target.value);
            if (d) backfill.mutate(d);
          }}
          disabled={backfill.isPending}
          className="px-2 py-1.5 rounded-md bg-white/5 border border-white/15 text-xs text-slate-300 focus:outline-none focus:border-sky-600"
          title="Pull older history from Verkada. Runs in the background on the poller's budget."
          aria-label="backfill older history"
        >
          <option value="">Pull older history…</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="365">Last year</option>
        </select>
        <a
          href={exportHref}
          className="text-xs px-2.5 py-1.5 rounded-md border border-white/15 text-slate-300 hover:bg-white/10 transition-colors"
          title="Download this slice as CSV (up to 50,000 rows)"
        >
          Export CSV
        </a>
      </div>
    </div>
  );
}

function PollPill({ status }: { status: AuditStatus | undefined }) {
  // Re-render every few seconds so "12s ago" stays honest without a
  // query round-trip.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  if (!status) return null;
  let dot = "bg-slate-500";
  let text = "";
  let title = "";
  switch (status.phase) {
    case "live":
      dot = "bg-emerald-400";
      text = `Live · every ${status.interval_sec}s`;
      title = `Last successful poll ${fmtRel(status.last_ok_at)} · ${fmtNum(status.total)} events stored`;
      break;
    case "backfilling":
      dot = "bg-sky-400";
      text = `Backfilling ${Math.floor(status.backfill.percent)}%`;
      title = `${fmtDuration(status.backfill.remaining_sec)} of history still to fetch · live rows keep arriving meanwhile`;
      break;
    case "starting":
      dot = "bg-sky-400";
      text = "Starting…";
      title = "The worker has not completed a poll yet";
      break;
    case "stalled":
      dot = "bg-amber-400";
      text = `Stalled · last ${fmtRel(status.last_ok_at)}`;
      title = "No successful poll recently. Is the worker running?";
      break;
    case "error":
      dot = "bg-rose-400";
      text = "Poll failing";
      title = status.last_error ?? "";
      break;
    default:
      dot = "bg-slate-500";
      text = "No Verkada connection";
      title = "Add a Verkada connection to start collecting the audit log";
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-slate-300 px-2 py-1 rounded-md border border-white/10 bg-white/5"
      title={title}
      data-testid="audit-poll-status"
      data-phase={status.phase}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} aria-hidden />
      {text}
    </span>
  );
}

/** The filters currently applied, as removable chips. */
export function ActiveChips({
  filters,
  setFilters,
}: {
  filters: AuditFilters;
  setFilters: (f: AuditFilters | ((p: AuditFilters) => AuditFilters)) => void;
}) {
  const n = activeCount(filters);
  if (n === 0 && filters.range !== "custom") return null;
  const chips: Array<{ key: string; label: string; onClear: () => void }> = [];
  if (filters.range === "custom") {
    chips.push({
      key: "range",
      label: `window: ${filters.since ? new Date(filters.since).toLocaleString() : "…"} → ${
        filters.until ? new Date(filters.until).toLocaleString() : "now"
      }`,
      onClear: () => setFilters((f) => ({ ...f, range: "24h", since: null, until: null })),
    });
  }
  if (filters.q)
    chips.push({ key: "q", label: `"${filters.q}"`, onClear: () => setFilters((f) => ({ ...f, q: "" })) });
  for (const k of LIST_KEYS) {
    for (const v of filters[k]) {
      const label =
        k === "category" ? CATEGORY_LABEL[v] ?? v : k === "actor" ? ACTOR_LABEL[v] ?? v : v;
      chips.push({
        key: `${k}:${v}`,
        label: `${k.replace("_", " ")}: ${label}`,
        onClear: () => setFilters((f) => ({ ...f, [k]: f[k].filter((x) => x !== v) })),
      });
    }
  }
  for (const k of SCALAR_KEYS) {
    if (filters[k])
      chips.push({
        key: k,
        label: `${k.replace("_", " ")}: ${filters[k]}`,
        onClear: () => setFilters((f) => ({ ...f, [k]: "" })),
      });
  }
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {chips.map((c) => (
        <span
          key={c.key}
          className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded bg-sky-950/40 border border-sky-700 text-sky-200 max-w-[24rem]"
        >
          <span className="truncate">{c.label}</span>
          <button
            type="button"
            onClick={c.onClear}
            className="text-slate-400 hover:text-white"
            aria-label={`remove ${c.label}`}
          >
            ×
          </button>
        </span>
      ))}
      {n > 1 && (
        <button
          type="button"
          onClick={() => setFilters((f) => clearAll(f))}
          className="text-xs text-slate-400 hover:text-white px-1.5 py-1"
        >
          Clear all
        </button>
      )}
    </div>
  );
}
