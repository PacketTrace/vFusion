import { useState } from "react";

import { AuditFacetValue, AuditFacets } from "../../lib/api";
import {
  ACTOR_LABEL,
  AuditFilters,
  CATEGORY_LABEL,
  ListKey,
  ScalarKey,
  setScalar,
  toggleListValue,
} from "../../lib/auditFilters";
import { fmtNum } from "../../lib/format";

type Group =
  | { kind: "list"; key: ListKey; title: string; facet: keyof AuditFacets; open?: boolean; label?: (v: string) => string }
  | { kind: "scalar"; key: ScalarKey; title: string; facet: keyof AuditFacets; open?: boolean };

const GROUPS: Group[] = [
  { kind: "list", key: "category", title: "Category", facet: "category", open: true, label: (v) => CATEGORY_LABEL[v] ?? v },
  { kind: "list", key: "event_name", title: "Event", facet: "event_name", open: true },
  { kind: "scalar", key: "user", title: "User / key", facet: "user", open: true },
  { kind: "list", key: "actor", title: "Actor", facet: "actor", label: (v) => ACTOR_LABEL[v] ?? v },
  { kind: "scalar", key: "device", title: "Device", facet: "device" },
  { kind: "list", key: "device_type", title: "Device type", facet: "device_type" },
  { kind: "list", key: "site", title: "Site", facet: "site" },
  { kind: "scalar", key: "ip", title: "IP address", facet: "ip" },
  { kind: "list", key: "api_key", title: "API key", facet: "api_key" },
  { kind: "list", key: "method", title: "Method", facet: "method" },
  { kind: "list", key: "status", title: "Status code", facet: "status" },
];

/**
 * Counts per value for the current slice, each one a click away from
 * being a filter. Counts come from the same query as the list, so a
 * number here is always the number of rows you would get.
 */
export default function FacetRail({
  facets,
  filters,
  setFilters,
}: {
  facets: AuditFacets | undefined;
  filters: AuditFilters;
  setFilters: (f: AuditFilters | ((p: AuditFilters) => AuditFilters)) => void;
}) {
  return (
    <div className="space-y-1.5 text-sm">
      {GROUPS.map((g) => {
        const values = (facets?.[g.facet] as AuditFacetValue[] | undefined) ?? [];
        const active =
          g.kind === "list" ? filters[g.key] : filters[g.key] ? [filters[g.key]] : [];
        if (values.length === 0 && active.length === 0) return null;
        return (
          <FacetGroup
            key={g.key}
            title={g.title}
            activeCount={active.length}
            defaultOpen={!!g.open}
          >
            <ul className="space-y-0.5">
              {values.map((v) => {
                const on = active.includes(v.value);
                const label =
                  g.kind === "list" && g.label
                    ? g.label(v.value)
                    : v.value;
                return (
                  <li key={v.value}>
                    <button
                      type="button"
                      onClick={() =>
                        setFilters((f) =>
                          g.kind === "list"
                            ? toggleListValue(f, g.key, v.value)
                            : setScalar(f, g.key, v.value),
                        )
                      }
                      className={`w-full flex items-center justify-between gap-2 px-2 py-1 rounded text-left text-xs transition-colors ${
                        on
                          ? "bg-sky-950/50 text-sky-100 border border-sky-700"
                          : "text-slate-300 hover:bg-white/5 border border-transparent"
                      }`}
                      title={v.label ? `${label} · ${v.label}` : label}
                      aria-pressed={on}
                    >
                      <span className="truncate">
                        {label}
                        {v.label && v.label !== label && (
                          <span className="text-slate-500"> · {v.label}</span>
                        )}
                      </span>
                      <span className="text-slate-500 tabular-nums shrink-0">{fmtNum(v.count)}</span>
                    </button>
                  </li>
                );
              })}
              {active
                .filter((a) => !values.some((v) => v.value === a))
                .map((a) => (
                  <li key={`active:${a}`}>
                    <button
                      type="button"
                      onClick={() =>
                        setFilters((f) =>
                          g.kind === "list" ? toggleListValue(f, g.key, a) : setScalar(f, g.key, a),
                        )
                      }
                      className="w-full flex items-center justify-between gap-2 px-2 py-1 rounded text-left text-xs bg-sky-950/50 text-sky-100 border border-sky-700"
                      title="Selected, but nothing in this slice matches it"
                    >
                      <span className="truncate">{a}</span>
                      <span className="text-slate-500">0</span>
                    </button>
                  </li>
                ))}
            </ul>
          </FacetGroup>
        );
      })}
    </div>
  );
}

function FacetGroup({
  title,
  activeCount,
  defaultOpen,
  children,
}: {
  title: string;
  activeCount: number;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen || activeCount > 0);
  return (
    <div className="rounded-lg border border-white/10 bg-white/5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-white/5 transition-colors rounded-lg"
      >
        <span
          className={`text-slate-500 text-[10px] leading-none transition-transform duration-200 ease-out-strong ${
            open ? "rotate-90" : ""
          }`}
          aria-hidden
        >
          ▶
        </span>
        <span className="text-xs font-semibold text-slate-200">{title}</span>
        {activeCount > 0 && (
          <span className="ml-auto text-[10px] px-1.5 rounded bg-sky-900/60 text-sky-200">
            {activeCount}
          </span>
        )}
      </button>
      {open && <div className="px-1.5 pb-1.5">{children}</div>}
    </div>
  );
}
