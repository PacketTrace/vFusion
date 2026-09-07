import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";

import { apiGet, AuditEvent, AuditEventList, AuditEventListItem, AuditFacets, AuditStatus } from "../lib/api";
import { filtersKey, filtersToApiParams } from "../lib/auditFilters";
import { useAuditFilters } from "../lib/useAuditFilters";
import { fmtBytes, fmtDateTime, fmtNum, fmtRel, fmtTime } from "../lib/format";
import JsonView from "../components/JsonView";
import AuditFilterBar, { ActiveChips } from "../components/audit/AuditFilterBar";
import FacetRail from "../components/audit/FacetRail";
import { ActorBadge, CategoryBadge, MethodBadge, StatusBadge } from "../components/audit/AuditBadges";

const PAGE = 100;

/**
 * Explorer → Audit log. Every row Verkada's audit log has produced,
 * filterable by anything on it, arriving every ten seconds.
 */
export default function AuditLog() {
  const { filters, setFilters } = useAuditFilters();
  const key = filtersKey(filters);
  const [sp, setSp] = useSearchParams();
  const selectedId = sp.get("event");
  const setSelectedId = (id: string | null) => {
    const next = new URLSearchParams(sp);
    if (id) next.set("event", id);
    else next.delete("event");
    setSp(next, { replace: true });
  };

  const list = useInfiniteQuery({
    queryKey: ["audit-events", key],
    queryFn: ({ pageParam }) => {
      const p = filtersToApiParams(filters);
      p.set("limit", String(PAGE));
      p.set("offset", String(pageParam));
      return apiGet<AuditEventList>(`/api/audit-events?${p.toString()}`);
    },
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    refetchInterval: 10_000,
  });

  const facets = useQuery({
    queryKey: ["audit-facets", key],
    queryFn: () => apiGet<AuditFacets>(`/api/audit-events/facets?${filtersToApiParams(filters).toString()}`),
    refetchInterval: 10_000,
  });

  const status = useQuery({
    queryKey: ["audit-status"],
    queryFn: () => apiGet<AuditStatus>("/api/audit-events/status"),
    refetchInterval: 10_000,
  });

  const detail = useQuery({
    queryKey: ["audit-event", selectedId],
    queryFn: () => apiGet<AuditEvent>(`/api/audit-events/${selectedId}`),
    enabled: selectedId !== null,
  });

  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const total = list.data?.pages[0]?.total ?? 0;

  // Rows that arrived since the previous fetch get a brief tint. The
  // first load seeds the set silently -- a page opening is not "new
  // events", and tinting a hundred rows at once says nothing.
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!list.data) return;
    const ids = items.map((i) => i.id);
    if (known.current === null) {
      known.current = new Set(ids);
      return;
    }
    const arrived = ids.filter((id) => !known.current!.has(id));
    for (const id of ids) known.current.add(id);
    if (arrived.length === 0) return;
    setFresh(new Set(arrived));
    const t = setTimeout(() => setFresh(new Set()), 1500);
    return () => clearTimeout(t);
  }, [items, list.data]);
  // A different slice is a different page; don't tint its first load.
  useEffect(() => {
    known.current = null;
  }, [key]);

  return (
    <div className="h-full flex flex-col gap-3 min-h-0">
      <AuditFilterBar
        filters={filters}
        setFilters={setFilters}
        status={status.data}
        selfHidden={facets.data?.self_hidden}
        total={list.data ? total : undefined}
      />
      <ActiveChips filters={filters} setFilters={setFilters} />

      <div className="grid grid-cols-12 gap-4 flex-1 min-h-0">
        <aside className="col-span-2 overflow-y-auto min-h-0 pr-1">
          <FacetRail facets={facets.data} filters={filters} setFilters={setFilters} />
        </aside>

        <div className="col-span-4 border border-white/15 rounded-lg overflow-hidden bg-white/5 flex flex-col min-h-0">
          {list.isLoading ? (
            <div className="p-4 text-sm text-slate-500">Loading…</div>
          ) : items.length === 0 ? (
            <EmptyState status={status.data} selfHidden={facets.data?.self_hidden ?? 0} onShowSelf={() => setFilters((f) => ({ ...f, include_self: true }))} />
          ) : (
            <ul className="divide-y divide-white/10 overflow-y-auto flex-1" data-testid="audit-list">
              {items.map((e) => (
                <Row
                  key={e.id}
                  e={e}
                  selected={selectedId === e.id}
                  fresh={fresh.has(e.id)}
                  onClick={() => setSelectedId(e.id)}
                />
              ))}
              {list.hasNextPage && (
                <li className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => list.fetchNextPage()}
                    disabled={list.isFetchingNextPage}
                    className="w-full text-xs px-2 py-1 rounded border border-white/15 text-slate-300 hover:border-sky-600 disabled:opacity-50"
                  >
                    {list.isFetchingNextPage ? "Loading…" : `Load older  (${fmtNum(items.length)} / ${fmtNum(total)})`}
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>

        <div className="col-span-6 border border-white/15 rounded-lg bg-white/5 overflow-hidden flex flex-col min-h-0">
          {detail.data ? (
            <Detail
              event={detail.data}
              onFilter={(patch) => setFilters((f) => ({ ...f, ...patch }))}
            />
          ) : selectedId && detail.isLoading ? (
            <div className="p-4 text-sm text-slate-500">Loading…</div>
          ) : (
            <div className="p-6 text-sm text-slate-500">
              Select an event to see who did it, from where, to what, and the details Verkada recorded.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function who(e: AuditEventListItem): string {
  if (e.actor === "api_key") return e.api_key_name ? `key: ${e.api_key_name}` : "API key";
  if (e.user_name) return e.user_name;
  if (e.user_email) return e.user_email;
  if (e.actor === "support") return "Verkada Support";
  return "system";
}

function Row({
  e,
  selected,
  fresh,
  onClick,
}: {
  e: AuditEventListItem;
  selected: boolean;
  fresh: boolean;
  onClick: () => void;
}) {
  const isApi = e.category === "api";
  return (
    <li
      onClick={onClick}
      className={`audit-row px-3 py-2 cursor-pointer text-sm ${
        selected ? "bg-white/10" : "hover:bg-white/5"
      } ${fresh ? "audit-row-new" : ""}`}
      data-testid="audit-row"
    >
      <div className="flex items-center gap-2 min-w-0">
        <CategoryBadge category={e.category} small />
        {isApi ? (
          <>
            <MethodBadge method={e.method} />
            <span className="text-[12px] font-mono text-slate-200 truncate">{e.url_path ?? "—"}</span>
            <StatusBadge code={e.status_code} />
          </>
        ) : (
          <span className="text-[13px] text-slate-100 truncate">{e.event_name}</span>
        )}
      </div>
      <div className="text-xs text-slate-500 mt-1 flex items-center gap-2 min-w-0">
        <span className="tabular-nums shrink-0">{fmtTime(e.timestamp)}</span>
        <span className="text-slate-400 truncate">{who(e)}</span>
        {e.device_name && (
          <span className="truncate text-slate-500">
            · {e.device_name}
            {e.device_count > 1 ? ` +${e.device_count - 1}` : ""}
          </span>
        )}
        {e.ip_address && <span className="ml-auto font-mono shrink-0">{e.ip_address}</span>}
      </div>
    </li>
  );
}

function EmptyState({
  status,
  selfHidden,
  onShowSelf,
}: {
  status: AuditStatus | undefined;
  selfHidden: number;
  onShowSelf: () => void;
}) {
  if (status?.phase === "unconfigured") {
    return (
      <div className="p-6 text-sm text-slate-400 space-y-2">
        <p className="font-medium text-slate-200">No Verkada connection yet.</p>
        <p>Add one under Connections and the audit log starts collecting within a minute, seven days back.</p>
      </div>
    );
  }
  if (status && status.total === 0) {
    return (
      <div className="p-6 text-sm text-slate-400 space-y-2">
        <p className="font-medium text-slate-200">Collecting…</p>
        <p>
          {status.phase === "backfilling" || status.phase === "starting"
            ? "The first pull from Verkada is under way. Rows appear here as they land."
            : status.phase === "error"
              ? `The poller is failing: ${status.last_error ?? "unknown error"}`
              : "Nothing has been stored yet."}
        </p>
      </div>
    );
  }
  return (
    <div className="p-6 text-sm text-slate-400 space-y-2">
      <p className="font-medium text-slate-200">Nothing matches.</p>
      {selfHidden > 0 ? (
        <p>
          {fmtNum(selfHidden)} row{selfHidden === 1 ? " is" : "s are"} hidden because they are this
          install's own API calls.{" "}
          <button type="button" onClick={onShowSelf} className="text-sky-300 hover:underline">
            Show them
          </button>
          .
        </p>
      ) : (
        <p>Widen the time range or remove a filter.</p>
      )}
    </div>
  );
}

function Detail({
  event: e,
  onFilter,
}: {
  event: AuditEvent;
  onFilter: (patch: Record<string, unknown>) => void;
}) {
  const isApi = e.category === "api";
  const links: Array<{ label: string; patch: Record<string, unknown> }> = [];
  if (e.user_email || e.user_name) links.push({ label: "this user", patch: { user: e.user_email ?? e.user_name } });
  if (e.api_key_name) links.push({ label: "this key", patch: { api_key: [e.api_key_name] } });
  if (e.ip_address) links.push({ label: "this IP", patch: { ip: e.ip_address } });
  if (e.device_id) links.push({ label: "this device", patch: { device_id: e.device_id } });
  links.push({ label: "this event type", patch: { event_name: [e.event_name] } });
  if (isApi && e.url_path) links.push({ label: "this endpoint", patch: { url: e.url_path } });

  return (
    <div className="overflow-y-auto flex-1 min-h-0">
      <div className="px-4 py-3 border-b border-white/10 space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <CategoryBadge category={e.category} />
          <ActorBadge actor={e.actor} />
          {e.is_self && (
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-white/10 text-slate-500" title="Made with this install's own Verkada key">
              own call
            </span>
          )}
        </div>
        <h2 className="text-base font-semibold text-white">
          {isApi ? (
            <span className="flex items-center gap-2 font-mono text-sm">
              <MethodBadge method={e.method} />
              <span className="break-all">{e.url_path}</span>
              <StatusBadge code={e.status_code} />
            </span>
          ) : (
            e.event_name
          )}
        </h2>
        {e.event_description && e.event_description !== e.event_name && (
          <p className="text-xs text-slate-400">{e.event_description}</p>
        )}
        <p className="text-xs text-slate-500">
          {fmtDateTime(e.timestamp)} · {fmtRel(e.timestamp)}
        </p>
      </div>

      <div className="px-4 py-3 border-b border-white/10 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <Fact label="Who">
          {e.actor === "api_key" ? (
            <>
              {e.api_key_name ?? "API key"}
              {e.api_key_tail && <span className="text-slate-500 font-mono"> …{e.api_key_tail}</span>}
            </>
          ) : (
            <>
              {e.user_name ?? "—"}
              {e.user_email && <span className="text-slate-400"> · {e.user_email}</span>}
            </>
          )}
        </Fact>
        <Fact label="From">
          <span className="font-mono">{e.ip_address ?? "—"}</span>
        </Fact>
        {isApi && (
          <>
            <Fact label="Response">
              <span className="font-mono">{e.status_code ?? "—"}</span>
              {e.response_size !== null && <span className="text-slate-400"> · {fmtBytes(e.response_size)}</span>}
            </Fact>
            <Fact label="Key">
              {e.api_key_name ?? "—"}
            </Fact>
          </>
        )}
        {e.user_id && (
          <Fact label="User id">
            <span className="font-mono break-all">{e.user_id}</span>
          </Fact>
        )}
        {e.org_id && (
          <Fact label="Org">
            <span className="font-mono break-all">{e.org_id}</span>
          </Fact>
        )}
        <Fact label="Processed">
          {e.processed_at ? fmtDateTime(e.processed_at) : "—"}
        </Fact>
        <Fact label="Stored">{fmtDateTime(e.ingested_at)}</Fact>
      </div>

      {e.devices.length > 0 && (
        <div className="px-4 py-3 border-b border-white/10">
          <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1.5">
            Device{e.devices.length === 1 ? "" : `s (${e.devices.length})`}
          </div>
          <ul className="space-y-1 text-xs">
            {e.devices.map((d, i) => (
              <li key={`${d.device_id ?? i}`} className="flex items-center gap-2 flex-wrap">
                <span className="text-slate-100">{d.device_name ?? d.device_id ?? "device"}</span>
                {d.device_type && <span className="text-slate-500">{d.device_type}</span>}
                {d.device_site_name && <span className="text-slate-500">· {d.device_site_name}</span>}
                {typeof d.details?.serial_number === "string" && (
                  <span className="font-mono text-slate-500">{d.details.serial_number}</span>
                )}
                {d.device_id && (
                  <button
                    type="button"
                    onClick={() => onFilter({ device_id: d.device_id })}
                    className="text-sky-300 hover:underline"
                  >
                    filter
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="px-4 py-3 border-b border-white/10">
        <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1.5">Show more from</div>
        <div className="flex flex-wrap gap-1.5">
          {links.map((l) => (
            <button
              key={l.label}
              type="button"
              onClick={() => onFilter(l.patch)}
              className="text-xs px-2 py-1 rounded border border-white/15 text-slate-300 hover:bg-white/10 transition-colors"
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 py-3 border-b border-white/10">
        <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1.5">Details</div>
        {Object.keys(e.details).length === 0 ? (
          <div className="text-xs text-slate-500">Verkada recorded no extra details for this event.</div>
        ) : (
          <div className="text-xs">
            <JsonView value={e.details} />
          </div>
        )}
      </div>

      <div className="px-4 py-3">
        <details>
          <summary className="text-[11px] uppercase tracking-wide text-slate-500 cursor-pointer">
            Raw entry
          </summary>
          <div className="text-xs mt-2">
            <JsonView value={e.raw} defaultOpen={false} openDepth={1} />
          </div>
        </details>
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-slate-200 break-words">{children}</div>
    </div>
  );
}
