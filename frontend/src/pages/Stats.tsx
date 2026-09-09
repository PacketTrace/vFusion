import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api";






interface StorageBucket {
  label: string;
  bytes: number;
  file_count: number;
}








interface SystemLoad {
  cpu_percent: number;
  cpu_count: number;
  load_avg_1m: number | null;
  load_avg_5m: number | null;
  load_avg_15m: number | null;
  mem_total_bytes: number;
  mem_used_bytes: number;
  mem_percent: number;
  swap_used_bytes: number;
  disk_total_bytes: number;
  disk_used_bytes: number;
  disk_percent: number;
  process_rss_bytes: number;
  process_threads: number;
  uptime_seconds: number;
  sampled_at: string;
}


interface StatsOverview {
  generated_at: string;
  webhooks_total: number;
  webhooks_last_24h: number;
  webhooks_last_7d: number;
  webhooks_last_30d: number;
  runs_total: number;
  runs_last_24h: number;
  runs_success_rate: number | null;
  storage: StorageBucket[];
  storage_total_bytes: number;
}


function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}


export default function Stats() {
  const stats = useQuery({
    queryKey: ["stats-overview"],
    queryFn: () => apiGet<StatsOverview>("/api/stats/overview"),
    refetchInterval: 30000,
  });
  const coverage = useQuery({
    queryKey: ["taxonomy-coverage"],
    queryFn: () => apiGet<Coverage>("/api/taxonomy/coverage"),
  });
  const system = useQuery({
    queryKey: ["stats-system"],
    queryFn: () => apiGet<SystemLoad>("/api/stats/system"),
    refetchInterval: 5000,
  });

  const s = stats.data;
  const sys = system.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Stats</h1>
        <p className="text-slate-400 text-sm mt-1">
          Aggregate counters for ingest, flow runs, and on-disk storage.
        </p>
      </div>

      {stats.isLoading && (
        <Card>
          <div className="text-sm text-slate-400">Loading…</div>
        </Card>
      )}

      {s && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <StatTile label="Webhooks (24h)" value={s.webhooks_last_24h.toLocaleString()} />
            <StatTile label="Webhooks (7d)" value={s.webhooks_last_7d.toLocaleString()} />
            <StatTile label="Webhooks (30d)" value={s.webhooks_last_30d.toLocaleString()} />
            <StatTile label="Webhooks (all time)" value={s.webhooks_total.toLocaleString()} />
            <StatTile label="Flow runs (24h)" value={s.runs_last_24h.toLocaleString()} />
            <StatTile label="Flow runs (all time)" value={s.runs_total.toLocaleString()} />
            <StatTile
              label="Run success (24h)"
              value={
                s.runs_success_rate === null
                  ? "—"
                  : `${(s.runs_success_rate * 100).toFixed(0)}%`
              }
            />
            <StatTile label="Disk used" value={fmtBytes(s.storage_total_bytes)} />
          </div>

          {sys && <ServerLoadCard sys={sys} />}

          <Card title="Storage">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-400 text-xs uppercase tracking-wider">
                  <th className="pb-2 pr-4">Bucket</th>
                  <th className="pb-2 pr-4">Files</th>
                  <th className="pb-2">Size</th>
                </tr>
              </thead>
              <tbody>
                {s.storage.map((b) => (
                  <tr key={b.label} className="border-t border-white/10">
                    <td className="py-2 pr-4 text-slate-200">{b.label}</td>
                    <td className="py-2 pr-4 text-slate-400">{b.file_count.toLocaleString()}</td>
                    <td className="py-2 text-slate-200">{fmtBytes(b.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {coverage.data && <CoverageCard data={coverage.data} />}

          <p className="text-xs text-slate-500">
            Refreshed {new Date(s.generated_at).toLocaleString()}.
          </p>
        </>
      )}
    </div>
  );
}


function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}


function Meter({
  label,
  pct,
  detail,
}: {
  label: string;
  pct: number;
  detail: string;
}) {
  const tone =
    pct >= 90
      ? "bg-rose-500/70"
      : pct >= 75
        ? "bg-amber-500/70"
        : "bg-sky-500/70";
  return (
    <div>
      <div className="flex justify-between text-xs">
        <span className="text-slate-300">{label}</span>
        <span className="text-slate-400">
          {pct.toFixed(0)}% <span className="text-slate-500">· {detail}</span>
        </span>
      </div>
      <div className="h-1.5 bg-white/5 rounded mt-1 overflow-hidden">
        <div
          className={`h-full ${tone}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
  );
}


function ServerLoadCard({ sys }: { sys: SystemLoad }) {
  const loadDetail =
    sys.load_avg_1m !== null
      ? `load ${sys.load_avg_1m.toFixed(2)} / ${(sys.load_avg_5m ?? 0).toFixed(2)} / ${(sys.load_avg_15m ?? 0).toFixed(2)} · ${sys.cpu_count} cores`
      : `${sys.cpu_count} cores`;
  return (
    <Card title="Server load">
      <div className="space-y-3">
        <Meter
          label="CPU"
          pct={sys.cpu_percent}
          detail={loadDetail}
        />
        <Meter
          label="Memory"
          pct={sys.mem_percent}
          detail={`${fmtBytes(sys.mem_used_bytes)} / ${fmtBytes(sys.mem_total_bytes)}`}
        />
        <Meter
          label="Disk (/)"
          pct={sys.disk_percent}
          detail={`${fmtBytes(sys.disk_used_bytes)} / ${fmtBytes(sys.disk_total_bytes)}`}
        />
        <div className="grid grid-cols-3 gap-3 pt-2 border-t border-white/10 text-xs">
          <div>
            <div className="text-slate-500 uppercase tracking-wider text-[10px]">
              Backend RSS
            </div>
            <div className="text-slate-200 mt-0.5">
              {fmtBytes(sys.process_rss_bytes)}
            </div>
          </div>
          <div>
            <div className="text-slate-500 uppercase tracking-wider text-[10px]">
              Threads
            </div>
            <div className="text-slate-200 mt-0.5">{sys.process_threads}</div>
          </div>
          <div>
            <div className="text-slate-500 uppercase tracking-wider text-[10px]">
              Host uptime
            </div>
            <div className="text-slate-200 mt-0.5">
              {fmtDuration(sys.uptime_seconds)}
            </div>
          </div>
        </div>
        {sys.swap_used_bytes > 0 && (
          <div className="text-[11px] text-amber-300">
            ⚠ swap in use: {fmtBytes(sys.swap_used_bytes)} — host is memory-pressured.
          </div>
        )}
        <p className="text-[11px] text-slate-500">
          Live from the backend container (5s refresh). Memory & disk are
          cgroup-aware — they reflect the container's limits, not the host.
        </p>
      </div>
    </Card>
  );
}


function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg p-4">
      <div className="text-[10px] uppercase tracking-wider text-slate-400">
        {label}
      </div>
      <div className="text-2xl font-semibold text-white mt-1">{value}</div>
    </div>
  );
}


interface CoverageType {
  notification_type: string;
  label: string;
  count: number;
  last_seen: string | null;
}

interface CoverageFamily {
  family: string;
  label: string;
  types: CoverageType[];
  seen: number;
  total: number;
}

interface Coverage {
  families: CoverageFamily[];
  seen: number;
  total: number;
}


function Card({
  title,
  hint,
  children,
}: {
  title?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg p-4">
      {title && (
        <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
          <h2 className="text-xs uppercase tracking-wider text-slate-400">
            {title}
          </h2>
          {/* Rows here have been clickable the whole time and nothing
              said so. A chart you can drill into is only useful to
              somebody who already knows they can. */}
          {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
        </div>
      )}
      {children}
    </div>
  );
}


/**
 * The row above the two webhook charts: how far back they look, and
 * what is currently narrowing them.
 *
 * The charts had no window at all before, which meant they answered
 * "what has ever arrived here" -- a question whose answer stops moving
 * after a month and can never tell you what changed this morning. The
 * counters above still cover fixed windows, so this only governs the
 * two breakdowns and says so.
 */
function CoverageCard({ data }: { data: Coverage }) {
  const missing = data.families
    .map((f) => ({ ...f, types: f.types.filter((t) => t.count === 0) }))
    .filter((f) => f.types.length > 0);
  return (
    <Card title={`Event type coverage — ${data.seen} of ${data.total} seen`}>
      {missing.length === 0 ? (
        <div className="text-sm text-slate-300">
          Every event type in the taxonomy has at least one stored sample.
        </div>
      ) : (
        <>
          <p className="text-xs text-slate-400 mb-3">
            No sample of these yet, so the trigger filter picker has nothing
            to offer for them beyond the camera or door. Triggering one in
            Command is what teaches vFusion its fields.
          </p>
          <div className="space-y-3">
            {missing.map((f) => (
              <div key={f.family}>
                <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">
                  {f.label} — {f.seen}/{f.total} seen
                </div>
                <ul className="flex flex-wrap gap-1.5">
                  {f.types.map((t) => (
                    <li
                      key={t.notification_type}
                      className="text-xs px-2 py-1 rounded border border-white/10 bg-white/5 text-slate-300"
                      title={t.notification_type}
                    >
                      {t.label}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
