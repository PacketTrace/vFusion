import { useQuery } from "@tanstack/react-query";

import { apiGet, AuditStats, AuditStatus } from "../lib/api";
import { CATEGORY_LABEL, categoryColor, filtersKey, filtersToApiParams } from "../lib/auditFilters";
import { useAuditFilters } from "../lib/useAuditFilters";
import { fmtNum, fmtRel } from "../lib/format";
import { geoLabel, useGeo } from "../lib/useGeo";
import AuditFilterBar, { ActiveChips } from "../components/audit/AuditFilterBar";
import { CategoryBadge, MethodBadge, statusTone } from "../components/audit/AuditBadges";
import { HBars, Legend, StackedColumns, StatTile } from "../components/audit/charts";
import StreamingSection from "../components/audit/StreamingSection";

/**
 * Explorer → Insights. The big picture of the same slice the Audit log
 * tab lists: who is active, what they do, from where, against which
 * devices and endpoints, and when. Every mark is a link into the rows
 * behind it.
 */
export default function AuditInsights({ embedded = false }: { embedded?: boolean }) {
  const { filters, setFilters, showInList } = useAuditFilters();
  const key = filtersKey(filters);

  const stats = useQuery({
    queryKey: ["audit-stats", key],
    queryFn: () => apiGet<AuditStats>(`/api/audit-events/stats?${filtersToApiParams(filters).toString()}`),
    refetchInterval: 15_000,
    placeholderData: (prev) => prev,
  });
  const status = useQuery({
    queryKey: ["audit-status"],
    queryFn: () => apiGet<AuditStatus>("/api/audit-events/status"),
    refetchInterval: 10_000,
    enabled: !embedded,
  });

  const s = stats.data;
  const categories = s?.categories.map((c) => c.category) ?? [];
  const geo = useGeo(s?.ips.map((i) => i.ip) ?? []);

  return (
    <div className="flex flex-col gap-3">
      {!embedded && (
        <>
          <AuditFilterBar
            filters={filters}
            setFilters={setFilters}
            status={status.data}
            apiHidden={s?.totals.api_hidden}
            total={s?.totals.events}
          />
          <ActiveChips filters={filters} setFilters={setFilters} />
        </>
      )}

      {!s ? (
        <div className="text-sm text-slate-500 p-4">Loading…</div>
      ) : s.totals.events === 0 ? (
        <div className="rounded-lg border border-white/10 bg-white/5 p-6 text-sm text-slate-400 space-y-2">
          <p className="font-medium text-slate-200">Nothing in this range.</p>
          {s.totals.api_hidden > 0 ? (
            <p>
              {fmtNum(s.totals.api_hidden)} API requests are hidden.{" "}
              <button
                type="button"
                onClick={() => setFilters((f) => ({ ...f, hide_api: false }))}
                className="text-sky-300 hover:underline"
              >
                Show them
              </button>
              .
            </p>
          ) : (
            <p>Widen the time range, or wait for the backfill to land.</p>
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
            <StatTile label="Events" value={fmtNum(s.totals.events)} onClick={() => showInList((f) => f)} />
            <StatTile
              label="People & keys"
              value={fmtNum(s.totals.users)}
              hint="distinct actors"
            />
            <StatTile label="IP addresses" value={fmtNum(s.totals.ips)} />
            <StatTile label="Devices touched" value={fmtNum(s.totals.devices)} />
            <StatTile
              label="API requests"
              value={fmtNum(s.totals.api_requests)}
              hint={filters.hide_api ? "hidden from this view" : "including this install's own"}
              onClick={() => showInList((f) => ({ ...f, category: ["api"] }))}
            />
            <StatTile
              label="API errors"
              value={fmtNum(s.totals.errors)}
              tone={s.totals.errors > 0 ? "text-rose-300" : "text-white"}
              hint={s.totals.errors > 0 ? "⚠ status ≥ 400" : "status ≥ 400"}
              onClick={() => showInList((f) => ({ ...f, status: ["4xx", "5xx"] }))}
            />
          </div>

          <Card
            title="Activity over time"
            hint={`per ${bucketLabel(s.bucket_sec)} · click a column to see those rows`}
          >
            <StackedColumns
              data={s.timeseries}
              categories={categories}
              bucketSec={s.bucket_sec}
              onPick={(since, until) => showInList((f) => ({ ...f, range: "custom", since, until }))}
            />
            <div className="mt-2">
              <Legend categories={categories} />
            </div>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <Card title="Who is active" hint="and what each spends their time doing">
              {s.users.length === 0 ? (
                <div className="text-xs text-slate-500">Nobody in this range</div>
              ) : (
                <ul className="space-y-2">
                  {s.users.map((u) => {
                    const max = s.users[0].count;
                    return (
                      <li key={u.key}>
                        <button
                          type="button"
                          onClick={() =>
                            showInList((f) => ({
                              ...f,
                              user: u.actor === "api_key" ? "" : u.key,
                              api_key: u.actor === "api_key" ? [u.key] : f.api_key,
                            }))
                          }
                          className="w-full text-left rounded -mx-2 px-2 py-1.5 hover:bg-white/5 transition-colors"
                        >
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="truncate text-slate-100">
                              {u.name || u.key}
                              {u.name && u.name !== u.key && (
                                <span className="text-slate-500"> · {u.key}</span>
                              )}
                            </span>
                            <span className="text-slate-400 tabular-nums shrink-0">
                              {fmtNum(u.count)}
                              {u.ips > 1 && <span className="text-slate-500"> · {u.ips} IPs</span>}
                            </span>
                          </div>
                          <div className="h-1.5 bg-white/5 rounded mt-1 overflow-hidden flex gap-px">
                            {stackFor(u.top, u.count, max)}
                          </div>
                          <div className="text-[11px] text-slate-500 mt-1 truncate">
                            {u.top
                              .slice(0, 3)
                              .map((t) => `${t.event_name} ×${fmtNum(t.count)}`)
                              .join(" · ")}
                            {u.last && <span> · last {fmtRel(u.last)}</span>}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            <Card title="What is happening" hint="events by type">
              <HBars
                items={s.events.map((e) => ({
                  key: e.event_name,
                  label: e.event_name,
                  sub: CATEGORY_LABEL[e.category] ?? e.category,
                  count: e.count,
                  color: categoryColor(e.category),
                }))}
                onPick={(k) => showInList((f) => ({ ...f, event_name: [k] }))}
              />
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <Card title="Devices" hint="most-touched first">
              <HBars
                items={s.devices.map((d) => ({
                  key: d.device_id,
                  label: d.name ?? d.device_id,
                  sub: [d.type, d.site].filter(Boolean).join(" · "),
                  count: d.count,
                }))}
                onPick={(k) => showInList((f) => ({ ...f, device_id: k }))}
              />
            </Card>
            <Card title="Where from" hint="IP addresses">
              {s.ips.length === 0 ? (
                <div className="text-xs text-slate-500">Nothing in this range</div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="text-slate-500">
                    <tr>
                      <th className="text-left font-normal pb-1">Address</th>
                      <th className="text-left font-normal pb-1">Location</th>
                      <th className="text-right font-normal pb-1">Actors</th>
                      <th className="text-right font-normal pb-1">Events</th>
                      <th className="text-right font-normal pb-1">Last</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.ips.map((ip) => (
                      <tr
                        key={ip.ip}
                        onClick={() => showInList((f) => ({ ...f, ip: ip.ip }))}
                        className="cursor-pointer hover:bg-white/5 transition-colors"
                      >
                        <td className="py-1 font-mono text-slate-200">{ip.ip}</td>
                        <td className="py-1 text-slate-400 truncate max-w-[12rem]">{geoLabel(geo[ip.ip]) ?? "—"}</td>
                        <td className="py-1 text-right tabular-nums text-slate-300">{ip.users}</td>
                        <td className="py-1 text-right tabular-nums text-slate-300">{fmtNum(ip.count)}</td>
                        <td className="py-1 text-right text-slate-500">{fmtRel(ip.last)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>

          {(s.endpoints.length > 0 || s.keys.length > 0) && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              <Card title="API endpoints" hint="by request count" className="lg:col-span-2">
                <table className="w-full text-xs">
                  <thead className="text-slate-500">
                    <tr>
                      <th className="text-left font-normal pb-1">Endpoint</th>
                      <th className="text-right font-normal pb-1">Requests</th>
                      <th className="text-right font-normal pb-1">Errors</th>
                      <th className="text-right font-normal pb-1">Keys</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.endpoints.map((ep) => (
                      <tr
                        key={`${ep.method}:${ep.url}`}
                        onClick={() =>
                          showInList((f) => ({
                            ...f,
                            category: ["api"],
                            url: ep.url,
                            method: ep.method ? [ep.method] : [],
                          }))
                        }
                        className="cursor-pointer hover:bg-white/5 transition-colors"
                      >
                        <td className="py-1 flex items-center gap-2 min-w-0">
                          <MethodBadge method={ep.method} />
                          <span className="font-mono text-slate-200 truncate">{ep.url}</span>
                        </td>
                        <td className="py-1 text-right tabular-nums text-slate-300">{fmtNum(ep.count)}</td>
                        <td className={`py-1 text-right tabular-nums ${ep.errors > 0 ? "text-rose-300" : "text-slate-500"}`}>
                          {ep.errors > 0 ? `⚠ ${fmtNum(ep.errors)}` : "0"}
                        </td>
                        <td className="py-1 text-right tabular-nums text-slate-500">{ep.keys}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
              <div className="flex flex-col gap-3">
                <Card title="API keys">
                  <HBars
                    items={s.keys.map((k) => ({
                      key: k.api_key_name,
                      label: k.api_key_name,
                      sub: `${k.ips} IP${k.ips === 1 ? "" : "s"}${k.errors ? ` · ⚠ ${fmtNum(k.errors)} errors` : ""} · last ${fmtRel(k.last)}`,
                      count: k.count,
                    }))}
                    onPick={(k) => showInList((f) => ({ ...f, api_key: [k] }))}
                  />
                </Card>
                <Card title="Status codes">
                  <ul className="flex flex-wrap gap-1.5">
                    {s.statuses.map((st) => (
                      <li key={st.status}>
                        <button
                          type="button"
                          onClick={() => showInList((f) => ({ ...f, status: [String(st.status)] }))}
                          className="text-xs px-2 py-1 rounded border border-white/10 bg-white/5 hover:bg-white/10 transition-colors"
                        >
                          <span className={`font-mono ${statusTone(st.status)}`}>{st.status}</span>
                          <span className="text-slate-400 tabular-nums"> {fmtNum(st.count)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </Card>
              </div>
            </div>
          )}

          <StreamingSection s={s} showInList={showInList} />

          <Card title="By category">
            <div className="flex flex-wrap gap-2">
              {s.categories.map((c) => (
                <button
                  key={c.category}
                  type="button"
                  onClick={() => showInList((f) => ({ ...f, category: [c.category] }))}
                  className="flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 hover:bg-white/10 transition-colors"
                >
                  <CategoryBadge category={c.category} small />
                  <span className="text-xs tabular-nums text-slate-300">{fmtNum(c.count)}</span>
                </button>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function stackFor(
  top: Array<{ event_name: string; category: string; count: number }>,
  total: number,
  max: number,
) {
  // Segment widths are shares of this user's total, scaled by the
  // user's share of the busiest user, so bars stay comparable across
  // rows and readable within one.
  const scale = total / max;
  const shown = top.reduce((n, t) => n + t.count, 0);
  const segs = top.map((t) => ({ ...t, w: (t.count / total) * scale * 100 }));
  const rest = Math.max(0, total - shown);
  return (
    <>
      {segs.map((t) => (
        <div
          key={t.event_name}
          style={{ width: `${t.w}%`, backgroundColor: categoryColor(t.category) }}
          title={`${t.event_name} ×${fmtNum(t.count)}`}
        />
      ))}
      {rest > 0 && (
        <div style={{ width: `${(rest / total) * scale * 100}%`, backgroundColor: "#6b7280" }} title={`other ×${fmtNum(rest)}`} />
      )}
    </>
  );
}

function bucketLabel(sec: number): string {
  if (sec < 3600) return `${sec / 60} min`;
  if (sec < 86400) return `${sec / 3600} h`;
  if (sec < 7 * 86400) return "day";
  return "week";
}

function Card({
  title,
  hint,
  children,
  className = "",
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-white/10 bg-white/5 p-3 ${className}`}>
      <div className="flex items-baseline gap-2 flex-wrap mb-2">
        <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
        {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
      </div>
      {children}
    </section>
  );
}
