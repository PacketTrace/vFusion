import { useState } from "react";

import { AuditStats } from "../../lib/api";
import { AuditFilters } from "../../lib/auditFilters";
import { fmtDuration, fmtNum } from "../../lib/format";
import { HBars, StatTile } from "./charts";

/**
 * Streaming activity: who watched which camera, for how long, and when.
 *
 * Built from the audit log's stream events. A history view carries its
 * start and duration, so it is a span; a live view has only a start, so
 * it is a mark. The swimlane is the point of the section — a row per
 * camera with each session drawn where it happened — because "how are
 * my cameras being streamed" is a question about time, and a count
 * cannot answer it.
 */
export default function StreamingSection({
  s,
  onFilter,
}: {
  s: AuditStats;
  onFilter: (next: (f: AuditFilters) => AuditFilters) => void;
}) {
  const st = s.streaming;
  const since = new Date(s.since).getTime() / 1000;
  const until = new Date(s.until).getTime() / 1000;
  const streamEvents = ["Video History Streamed", "History Viewed", "Live Stream Started"];

  if (st.sessions === 0 && st.live_starts === 0) {
    return (
      <Card title="Streaming" hint="who watched which camera, and for how long">
        <div className="text-xs text-slate-500">
          No streaming in this range. Stream events arrive as <em>Video History Streamed</em> and{" "}
          <em>Live Stream Started</em> in the audit log.
        </div>
      </Card>
    );
  }

  return (
    <Card title="Streaming" hint="who watched which camera, and for how long · click anything to narrow to it">
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mb-3">
        <StatTile
          label="Sessions"
          value={fmtNum(st.sessions)}
          hint="history views with a duration"
          onClick={() => onFilter((f) => ({ ...f, event_name: streamEvents }))}
        />
        <StatTile label="Live views" value={fmtNum(st.live_starts)} onClick={() => onFilter((f) => ({ ...f, event_name: ["Live Stream Started"] }))} />
        <StatTile label="Time streamed" value={fmtDuration(st.total_sec)} />
        <StatTile label="Average" value={fmtDuration(st.avg_sec)} hint={`median ${fmtDuration(st.median_sec)}`} />
        <StatTile label="Longest" value={fmtDuration(st.longest_sec)} />
        <StatTile label="Cameras" value={fmtNum(st.cameras.length)} hint={`${fmtNum(st.streamers.length)} viewers`} />
      </div>

      <Swimlanes lanes={st.lanes} since={since} until={until} onPick={(id) => onFilter((f) => ({ ...f, event_name: streamEvents, device_id: id }))} />
      {st.truncated && (
        <div className="text-[11px] text-amber-300 mt-1">
          Only the most recent {fmtNum(3000)} stream events are drawn. Narrow the range for a complete picture.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-3">
        <div>
          <div className="text-xs font-semibold text-slate-200 mb-1.5">Most-streamed cameras</div>
          <HBars
            items={st.cameras.map((c) => ({
              key: c.device_id ?? c.name,
              label: c.name,
              sub: `${fmtNum(c.sessions)} session${c.sessions === 1 ? "" : "s"} · avg ${fmtDuration(c.avg_sec)}`,
              count: c.total_sec,
              title: `${fmtDuration(c.total_sec)} streamed`,
            }))}
            onPick={(k) => onFilter((f) => ({ ...f, event_name: streamEvents, device_id: k }))}
          />
        </div>
        <div>
          <div className="text-xs font-semibold text-slate-200 mb-1.5">Top streamers</div>
          <HBars
            items={st.streamers.map((w) => ({
              key: w.key,
              label: w.name,
              sub: `${fmtNum(w.sessions)} session${w.sessions === 1 ? "" : "s"} · ${w.cameras} camera${w.cameras === 1 ? "" : "s"}${w.actor === "api_key" ? " · via API key" : ""}`,
              count: w.total_sec,
              title: `${fmtDuration(w.total_sec)} streamed`,
            }))}
            onPick={(k) => onFilter((f) => ({ ...f, event_name: streamEvents, user: k }))}
          />
        </div>
      </div>
    </Card>
  );
}

/** A row per camera, sessions as spans on a shared time axis. */
function Swimlanes({
  lanes,
  since,
  until,
  onPick,
}: {
  lanes: AuditStats["streaming"]["lanes"];
  since: number;
  until: number;
  onPick: (deviceId: string) => void;
}) {
  const [hover, setHover] = useState<{ lane: number; i: number; x: number } | null>(null);
  const span = Math.max(1, until - since);
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - since) / span) * 100));
  const ticks = 6;
  const hovered = hover ? lanes[hover.lane]?.items[hover.i] : null;

  if (lanes.length === 0) return null;
  return (
    <div className="relative select-none">
      <div className="grid gap-y-1" style={{ gridTemplateColumns: "11rem minmax(0, 1fr)" }}>
        <div />
        <div className="relative h-4 text-[10px] text-slate-500">
          {Array.from({ length: ticks + 1 }, (_, i) => {
            const t = since + (span * i) / ticks;
            return (
              <span
                key={i}
                className="absolute -translate-x-1/2"
                style={{ left: `${(i / ticks) * 100}%` }}
              >
                {tickLabel(t, span)}
              </span>
            );
          })}
        </div>
        {lanes.map((lane, li) => (
          <LaneRow key={lane.name} lane={lane} li={li} pct={pct} onPick={onPick} setHover={setHover} hover={hover} />
        ))}
      </div>
      {hovered && hover && (
        <div
          className="absolute z-10 pointer-events-none rounded-md border border-white/15 bg-slate-950/95 px-2.5 py-2 text-xs shadow-lg"
          style={{ left: `calc(11rem + ${Math.min(85, hover.x)}%)`, top: 0 }}
        >
          <div className="text-slate-100">{lanes[hover.lane].name}</div>
          <div className="text-slate-300">{hovered.who}</div>
          <div className="text-slate-400">
            {new Date(hovered.start * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}
            {hovered.kind === "live" ? " · live view" : ` · ${fmtDuration(hovered.end - hovered.start)}`}
            {hovered.local ? " · local" : ""}
          </div>
        </div>
      )}
    </div>
  );
}

function LaneRow({
  lane,
  li,
  pct,
  onPick,
  setHover,
  hover,
}: {
  lane: AuditStats["streaming"]["lanes"][number];
  li: number;
  pct: (t: number) => number;
  onPick: (deviceId: string) => void;
  setHover: (h: { lane: number; i: number; x: number } | null) => void;
  hover: { lane: number; i: number; x: number } | null;
}) {
  return (
    <>
      <button
        type="button"
        onClick={() => lane.device_id && onPick(lane.device_id)}
        className="text-left text-xs text-slate-300 truncate pr-2 hover:text-white"
        title={`${lane.items.length} session${lane.items.length === 1 ? "" : "s"}`}
      >
        {lane.name}
      </button>
      <div className="relative h-5 rounded bg-white/[0.04]">
        {lane.items.map((it, i) => {
          const left = pct(it.start);
          const width = Math.max(0.35, pct(it.end) - left);
          const dim = hover !== null && !(hover.lane === li && hover.i === i);
          return it.kind === "live" ? (
            <span
              key={it.id}
              className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full"
              style={{ left: `calc(${left}% - 4px)`, backgroundColor: "#d95926", opacity: dim ? 0.45 : 1 }}
              onMouseEnter={() => setHover({ lane: li, i, x: left })}
              onMouseLeave={() => setHover(null)}
            />
          ) : (
            <span
              key={it.id}
              className="absolute top-0.5 bottom-0.5 rounded-[3px]"
              style={{ left: `${left}%`, width: `${width}%`, backgroundColor: "#3987e5", opacity: dim ? 0.45 : 1 }}
              onMouseEnter={() => setHover({ lane: li, i, x: left })}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
      </div>
    </>
  );
}

function tickLabel(t: number, span: number): string {
  const d = new Date(t * 1000);
  if (span <= 2 * 86400) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (span <= 14 * 86400) return d.toLocaleString([], { weekday: "short", hour: "2-digit", hour12: false });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-white/10 bg-white/5 p-3">
      <div className="flex items-baseline gap-2 flex-wrap mb-2">
        <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
        {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
      </div>
      {children}
    </section>
  );
}
