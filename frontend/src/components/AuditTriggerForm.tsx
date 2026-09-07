import { useQuery } from "@tanstack/react-query";

import { apiGet, AuditFacets, Flow } from "../lib/api";
import { ACTOR_LABEL, CATEGORY_LABEL } from "../lib/auditFilters";

/**
 * The ``verkada_audit`` trigger: run a flow when something happens in
 * Command. Category / event / actor narrow it; filters are dot paths
 * into the trigger payload (who at the top, the target under ``data``),
 * matched the same way webhook filters are.
 */

export interface AuditTriggerState {
  category: string;
  eventName: string;
  actor: string;
  includeSelf: boolean;
  filters: Array<{ field: string; value: string }>;
}

export function auditStateFromConfig(c: Flow["trigger_config"] | undefined): AuditTriggerState {
  const cfg = (c ?? {}) as Record<string, unknown>;
  return {
    category: typeof cfg.category === "string" ? cfg.category : "",
    eventName: typeof cfg.event_name === "string" ? cfg.event_name : "",
    actor: typeof cfg.actor === "string" ? cfg.actor : "",
    includeSelf: cfg.include_self === true,
    filters: Object.entries((cfg.filters as Record<string, string> | undefined) ?? {}).map(
      ([field, value]) => ({ field, value: String(value) }),
    ),
  };
}

export function auditStateToConfig(s: AuditTriggerState): Flow["trigger_config"] {
  const out: Record<string, unknown> = {};
  if (s.category) out.category = s.category;
  if (s.eventName) out.event_name = s.eventName;
  if (s.actor) out.actor = s.actor;
  if (s.includeSelf) out.include_self = true;
  const filters: Record<string, string> = {};
  for (const { field, value } of s.filters) if (field && value) filters[field] = value;
  if (Object.keys(filters).length > 0) out.filters = filters;
  return out as Flow["trigger_config"];
}

export const DEFAULT_AUDIT_STATE: AuditTriggerState = {
  category: "",
  eventName: "",
  actor: "",
  includeSelf: false,
  filters: [],
};

// Paths worth offering by name. Anything else can be typed.
const FIELD_OPTIONS: Array<{ path: string; label: string; facet?: keyof AuditFacets }> = [
  { path: "user_email", label: "User email", facet: "user" },
  { path: "user_name", label: "User name" },
  { path: "ip_address", label: "IP address", facet: "ip" },
  { path: "api_key_name", label: "API key name", facet: "api_key" },
  { path: "data.device_name", label: "Device name", facet: "device" },
  { path: "data.device_type", label: "Device type", facet: "device_type" },
  { path: "data.device_site", label: "Site", facet: "site" },
  { path: "data.camera_id", label: "Camera id" },
  { path: "data.url", label: "API endpoint (path)" },
  { path: "method", label: "HTTP method", facet: "method" },
  { path: "status_code", label: "HTTP status", facet: "status" },
];

export default function AuditTriggerForm({
  value,
  onChange,
}: {
  value: AuditTriggerState;
  onChange: (next: AuditTriggerState) => void;
}) {
  // What has actually happened in the last 30 days, for the pickers.
  // The facets endpoint is the same one the Explorer uses, so the event
  // list here is exactly the event list there.
  const facets = useQuery({
    queryKey: ["audit-trigger-facets", value.category, value.includeSelf],
    queryFn: () => {
      const p = new URLSearchParams();
      p.set("since", new Date(Date.now() - 30 * 86400_000).toISOString());
      if (value.category) p.append("category", value.category);
      if (value.includeSelf) p.set("include_self", "true");
      return apiGet<AuditFacets>(`/api/audit-events/facets?${p.toString()}`);
    },
    staleTime: 60_000,
  });
  const f = facets.data;
  const events = f?.event_name ?? [];
  const set = (patch: Partial<AuditTriggerState>) => onChange({ ...value, ...patch });

  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-slate-400">
        Runs within ten seconds of a matching entry appearing in Command's audit log.
        History that arrives through a backfill never starts a flow.
      </p>

      <Field label="Category">
        <select
          value={value.category}
          onChange={(e) => set({ category: e.target.value, eventName: "" })}
          className={selectCls}
        >
          <option value="">Any category</option>
          {Object.entries(CATEGORY_LABEL).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Event" hint={f ? `${events.length} seen in the last 30 days` : undefined}>
        <input
          list="audit-trigger-events"
          value={value.eventName}
          onChange={(e) => set({ eventName: e.target.value })}
          placeholder="Any event — or pick one, e.g. Live Stream Started"
          className={inputCls}
        />
        <datalist id="audit-trigger-events">
          {events.map((ev) => (
            <option key={ev.value} value={ev.value}>
              {`${ev.count} in 30d`}
            </option>
          ))}
        </datalist>
      </Field>

      <Field label="Done by">
        <select value={value.actor} onChange={(e) => set({ actor: e.target.value })} className={selectCls}>
          <option value="">Anyone or anything</option>
          {Object.entries(ACTOR_LABEL).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </Field>

      <label className="flex items-start gap-2 text-xs text-slate-300">
        <input
          type="checkbox"
          checked={value.includeSelf}
          onChange={(e) => set({ includeSelf: e.target.checked })}
          className="mt-0.5"
        />
        <span>
          Include this install's own API calls
          <span className="block text-slate-500">
            Off by default: vFusion's own polling would otherwise start this flow constantly.
          </span>
        </span>
      </label>

      <div>
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-[11px] uppercase tracking-wider text-slate-400">Only when</span>
          <button
            type="button"
            onClick={() => set({ filters: [...value.filters, { field: "", value: "" }] })}
            className="text-xs text-sky-300 hover:underline"
          >
            + add filter
          </button>
        </div>
        {value.filters.length === 0 ? (
          <div className="text-xs text-slate-500">No field filters. Every matching event runs the flow.</div>
        ) : (
          <ul className="space-y-1.5">
            {value.filters.map((row, i) => {
              const opt = FIELD_OPTIONS.find((o) => o.path === row.field);
              const suggestions = opt?.facet ? (f?.[opt.facet] as Array<{ value: string }> | undefined) ?? [] : [];
              const listId = `audit-filter-values-${i}`;
              return (
                <li key={i} className="flex items-center gap-1.5">
                  <input
                    list="audit-filter-fields"
                    value={row.field}
                    onChange={(e) => {
                      const next = [...value.filters];
                      next[i] = { ...row, field: e.target.value };
                      set({ filters: next });
                    }}
                    placeholder="field, e.g. user_email"
                    className={`${inputCls} font-mono text-xs w-[45%]`}
                  />
                  <span className="text-slate-500 text-xs">=</span>
                  <input
                    list={listId}
                    value={row.value}
                    onChange={(e) => {
                      const next = [...value.filters];
                      next[i] = { ...row, value: e.target.value };
                      set({ filters: next });
                    }}
                    placeholder="value"
                    className={`${inputCls} text-xs flex-1`}
                  />
                  <datalist id={listId}>
                    {suggestions.map((s) => (
                      <option key={s.value} value={s.value} />
                    ))}
                  </datalist>
                  <button
                    type="button"
                    onClick={() => set({ filters: value.filters.filter((_, j) => j !== i) })}
                    className="text-slate-500 hover:text-slate-200 text-sm px-1"
                    aria-label="remove filter"
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <datalist id="audit-filter-fields">
          {FIELD_OPTIONS.map((o) => (
            <option key={o.path} value={o.path}>
              {o.label}
            </option>
          ))}
        </datalist>
        <p className="text-[11px] text-slate-500 mt-1.5">
          Fields are paths into the trigger payload: who at the top (
          <code className="font-mono">user_email</code>, <code className="font-mono">ip_address</code>), the
          target under <code className="font-mono">data</code> (
          <code className="font-mono">data.device_name</code>, <code className="font-mono">data.url</code>).
          Matches are case-insensitive equality.
        </p>
      </div>
    </div>
  );
}

const inputCls =
  "w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm focus:outline-none focus:border-sky-600";
const selectCls = inputCls;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-[11px] uppercase tracking-wider text-slate-400">{label}</span>
        {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
