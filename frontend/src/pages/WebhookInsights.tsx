import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";

import { apiGet } from "../lib/api";
import StatBars, { BarItem } from "../components/StatBars";

/**
 * The Webhooks tab, as a picture.
 *
 * These two charts lived on Settings → Stats, next to disk usage and
 * Gemini spend. They are not that: they are a summary of the very rows
 * on the other half of this tab, and the reason to look at one is
 * always to go and look at the other. Sitting three clicks away in an
 * unrelated page meant nobody who was looking at webhooks ever saw
 * them.
 *
 * Same arrangement the audit log already uses — Events or Insights over
 * the same data — so the two halves of Explorer work the same way.
 */

interface TypeCount {
  label: string;
  count: number;
  /** "notification_type" | "webhook_type" | "null" — which inbox filter
   *  a click should apply. */
  label_source?: string;
}

interface Breakdown {
  generated_at: string;
  by_type: TypeCount[];
  by_family: TypeCount[];
  range: string;
  family: string | null;
  total: number;
}

const RANGES = [
  { key: "24h", label: "24 hours" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "all", label: "All time" },
] as const;

export default function WebhookInsights({
  onPickType,
}: {
  /** Apply a type filter to the Events view and switch to it. Falls
   *  back to nothing when the host has no filter to drive. */
  onPickType?: (item: TypeCount) => void;
}) {
  const [params, setParams] = useSearchParams();
  const range = RANGES.find((r) => r.key === params.get("range"))?.key ?? "all";
  const family = params.get("family");

  const patch = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    setParams(p, { replace: true });
  };

  const q = useQuery({
    queryKey: ["webhook-breakdown", range, family],
    queryFn: () => {
      const qs = new URLSearchParams({ range });
      if (family) qs.set("family", family);
      return apiGet<Breakdown>(`/api/stats/webhooks?${qs}`);
    },
    refetchInterval: 30_000,
    // Hold the old numbers while the new ones load, rather than
    // collapsing both charts to "Loading…" on every filter click.
    placeholderData: (prev) => prev,
  });

  const d = q.data;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="inline-flex rounded-md border border-white/15 overflow-hidden">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => patch({ range: r.key === "all" ? null : r.key })}
              aria-pressed={range === r.key}
              className={`text-xs px-3 py-1.5 transition-colors ${
                range === r.key
                  ? "bg-sky-950/60 text-sky-200"
                  : "text-slate-400 hover:text-slate-200 hover:bg-white/5"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>

        {family && (
          <button
            type="button"
            onClick={() => patch({ family: null })}
            className="text-xs px-2.5 py-1.5 rounded-md border border-sky-600 bg-sky-950/40 text-sky-200 hover:bg-sky-950/70 transition-colors"
            title="Clear the family filter"
          >
            family: {family} <span className="text-sky-400/70 ml-0.5">×</span>
          </button>
        )}

        <span className="text-xs text-slate-500 ml-auto">
          {(d?.total ?? 0).toLocaleString()} webhook
          {d?.total === 1 ? "" : "s"} in this window
        </span>
      </div>

      {!d ? (
        <Card title="Webhooks by family">
          <div className="text-sm text-slate-500">Loading…</div>
        </Card>
      ) : (
        <>
          <Card
            title="Webhooks by family"
            hint="Click a family to narrow the event types below."
          >
            <StatBars
              total={d.total}
              items={d.by_family.map<BarItem>((item) => ({
                key: item.label,
                label: item.label,
                count: item.count,
                selected: family === item.label,
                onPick: () =>
                  patch({ family: family === item.label ? null : item.label }),
                title:
                  family === item.label
                    ? `${item.label} — filtering the event types below. Click to clear.`
                    : `${item.label} — ${item.count.toLocaleString()} webhooks. Click to narrow the event types below.`,
              }))}
            />
          </Card>

          <Card
            title={family ? `Top event types · ${family}` : "Top event types"}
            hint="Click a type to see those events."
          >
            <StatBars
              total={d.total}
              emptyText={
                family
                  ? `No ${family} webhooks in this window.`
                  : "Nothing in this window."
              }
              items={d.by_type.map<BarItem>((item) => ({
                key: `${item.label_source ?? ""}:${item.label}`,
                label: item.label,
                count: item.count,
                onPick: onPickType ? () => onPickType(item) : undefined,
              }))}
            />
          </Card>
        </>
      )}
    </div>
  );
}

function Card({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg p-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
        <h2 className="text-xs uppercase tracking-wider text-slate-400">
          {title}
        </h2>
        {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
