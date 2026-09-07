import { useLayoutEffect, useRef, useState } from "react";

import { CATEGORY_LABEL, categoryColor, NEUTRAL_SERIES } from "../../lib/auditFilters";
import { fmtNum } from "../../lib/format";

/* ------------------------------------------------------------------
 * Chart primitives for the Insights tab. Plain SVG and divs, no
 * library: the marks are simple, the app has no chart dependency, and
 * the hover layer is a few lines. Colour rules follow the dataviz
 * method: one hue per category (fixed slot), a neutral for the rest,
 * 2px surface gaps between stacked fills, recessive grid, and text in
 * text tokens rather than series colour.
 * ---------------------------------------------------------------- */

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(Math.floor(e.contentRect.width));
    });
    ro.observe(el);
    setW(Math.floor(el.clientWidth));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function seriesOrder(categories: string[]): string[] {
  // Fixed slot order first (so the same category always stacks in the
  // same place), then whatever else appeared, folded to the neutral.
  const slots = ["api", "cameras", "access", "users", "admin", "sensors", "integrations", "alarms"];
  const present = new Set(categories);
  return [...slots.filter((s) => present.has(s)), ...categories.filter((c) => !slots.includes(c))];
}

function tickLabel(t: number, bucketSec: number): string {
  const d = new Date(t * 1000);
  if (bucketSec < 3600) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (bucketSec < 86400)
    return d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function bucketRange(t: number, bucketSec: number): string {
  const a = new Date(t * 1000);
  const b = new Date((t + bucketSec) * 1000);
  const opts: Intl.DateTimeFormatOptions =
    bucketSec < 86400
      ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }
      : { month: "short", day: "numeric" };
  return `${a.toLocaleString([], opts)} – ${b.toLocaleString([], bucketSec < 86400 ? { hour: "2-digit", minute: "2-digit", hour12: false } : opts)}`;
}

export function StackedColumns({
  data,
  categories,
  bucketSec,
  onPick,
  height = 190,
}: {
  data: Array<{ t: number; total: number; by_category: Record<string, number> }>;
  categories: string[];
  bucketSec: number;
  onPick?: (sinceIso: string, untilIso: string) => void;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 40, r: 8, t: 8, b: 22 };
  const w = Math.max(0, width - pad.l - pad.r);
  const h = height - pad.t - pad.b;
  const n = data.length;
  const max = Math.max(1, ...data.map((d) => d.total));
  const step = n > 0 ? w / n : 0;
  const bar = Math.max(1, step - 1);
  const order = seriesOrder(categories);
  const gridVals = niceTicks(max, 3);
  const tickEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(w / 90))));

  const hovered = hover !== null ? data[hover] : null;

  return (
    <div ref={ref} className="relative w-full select-none">
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="events over time">
          {gridVals.map((v) => {
            const y = pad.t + h - (v / max) * h;
            return (
              <g key={v}>
                <line x1={pad.l} x2={width - pad.r} y1={y} y2={y} stroke="rgba(255,255,255,0.08)" />
                <text x={pad.l - 6} y={y + 3} textAnchor="end" fontSize={10} fill="#94a3b8">
                  {fmtNum(v)}
                </text>
              </g>
            );
          })}
          <line
            x1={pad.l}
            x2={width - pad.r}
            y1={pad.t + h}
            y2={pad.t + h}
            stroke="rgba(255,255,255,0.15)"
          />
          {data.map((d, i) => {
            const x = pad.l + i * step;
            let yTop = pad.t + h;
            const segs = order
              .filter((c) => (d.by_category[c] ?? 0) > 0)
              .map((c) => {
                const v = d.by_category[c];
                const segH = (v / max) * h;
                yTop -= segH;
                return { c, v, y: yTop, hh: segH };
              });
            return (
              <g key={d.t}>
                {segs.map((s, j) => (
                  <rect
                    key={s.c}
                    x={x}
                    y={s.y + (j < segs.length - 1 ? 1 : 0)}
                    width={bar}
                    height={Math.max(0, s.hh - (j < segs.length - 1 ? 2 : 0))}
                    fill={categoryColor(s.c)}
                    opacity={hover === null || hover === i ? 1 : 0.55}
                  />
                ))}
                {i % tickEvery === 0 && (
                  <text
                    x={x + bar / 2}
                    y={height - 6}
                    textAnchor={i === 0 ? "start" : "middle"}
                    fontSize={10}
                    fill="#94a3b8"
                  >
                    {tickLabel(d.t, bucketSec)}
                  </text>
                )}
                {/* Hit target is the whole column, wider than the mark. */}
                <rect
                  x={x}
                  y={pad.t}
                  width={Math.max(bar, step)}
                  height={h}
                  fill="transparent"
                  style={{ cursor: onPick ? "pointer" : "default" }}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() =>
                    onPick?.(
                      new Date(d.t * 1000).toISOString(),
                      new Date((d.t + bucketSec) * 1000).toISOString(),
                    )
                  }
                />
              </g>
            );
          })}
          {hover !== null && (
            <line
              x1={pad.l + hover * step + bar / 2}
              x2={pad.l + hover * step + bar / 2}
              y1={pad.t}
              y2={pad.t + h}
              stroke="rgba(255,255,255,0.35)"
              strokeDasharray="2 3"
              pointerEvents="none"
            />
          )}
        </svg>
      )}
      {hovered && (
        <div
          className="absolute z-10 pointer-events-none rounded-md border border-white/15 bg-slate-950/95 px-2.5 py-2 text-xs shadow-lg"
          style={{
            left: Math.min(width - 190, Math.max(0, pad.l + (hover ?? 0) * step + 10)),
            top: 4,
            minWidth: 170,
          }}
        >
          <div className="text-slate-400 mb-1">{bucketRange(hovered.t, bucketSec)}</div>
          <div className="text-slate-100 font-medium mb-1">{fmtNum(hovered.total)} events</div>
          {order
            .filter((c) => (hovered.by_category[c] ?? 0) > 0)
            .map((c) => (
              <div key={c} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 text-slate-300">
                  <span
                    className="inline-block w-2 h-2 rounded-full"
                    style={{ backgroundColor: categoryColor(c) }}
                  />
                  {CATEGORY_LABEL[c] ?? c}
                </span>
                <span className="tabular-nums text-slate-200">{fmtNum(hovered.by_category[c])}</span>
              </div>
            ))}
          {onPick && <div className="text-slate-500 mt-1">click to see these rows</div>}
        </div>
      )}
    </div>
  );
}

export function Legend({ categories }: { categories: string[] }) {
  if (categories.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-300">
      {seriesOrder(categories).map((c) => (
        <span key={c} className="inline-flex items-center gap-1.5">
          <span
            className="inline-block w-2.5 h-2.5 rounded-sm"
            style={{ backgroundColor: categoryColor(c) }}
          />
          {CATEGORY_LABEL[c] ?? c}
        </span>
      ))}
    </div>
  );
}

function niceTicks(max: number, count: number): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const stepN = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  const step = stepN * mag;
  const out: number[] = [];
  for (let v = step; v <= max; v += step) out.push(v);
  return out.length ? out : [max];
}

/** Horizontal bars, one hue (or the category's) with the label in text.
 *  Clickable rows become filters. */
export function HBars({
  items,
  color,
  onPick,
  emptyText = "Nothing in this range",
}: {
  items: Array<{
    key: string;
    label: React.ReactNode;
    sub?: React.ReactNode;
    count: number;
    color?: string;
    title?: string;
  }>;
  color?: string;
  onPick?: (key: string) => void;
  emptyText?: string;
}) {
  const max = Math.max(1, ...items.map((i) => i.count));
  if (items.length === 0) return <div className="text-xs text-slate-500">{emptyText}</div>;
  return (
    <ul className="space-y-1.5">
      {items.map((i) => {
        const body = (
          <>
            <div className="flex justify-between gap-2 text-xs">
              <span className="truncate text-slate-200">{i.label}</span>
              <span className="text-slate-400 tabular-nums shrink-0">{fmtNum(i.count)}</span>
            </div>
            {i.sub && <div className="text-[11px] text-slate-500 truncate">{i.sub}</div>}
            <div className="h-1.5 bg-white/5 rounded mt-1 overflow-hidden">
              <div
                className="h-full rounded"
                style={{
                  width: `${(i.count / max) * 100}%`,
                  backgroundColor: i.color ?? color ?? "#3987e5",
                  transition: "width 200ms var(--ease-out)",
                }}
              />
            </div>
          </>
        );
        return (
          <li key={i.key} title={i.title}>
            {onPick ? (
              <button
                type="button"
                onClick={() => onPick(i.key)}
                className="w-full text-left rounded -mx-2 px-2 py-1 hover:bg-white/5 transition-colors"
              >
                {body}
              </button>
            ) : (
              <div className="py-1">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = "text-white",
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: string;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums mt-0.5 ${tone}`}>{value}</div>
      {hint && <div className="text-[11px] text-slate-500 mt-0.5 truncate">{hint}</div>}
    </>
  );
  const cls = "rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 min-w-0";
  return onClick ? (
    <button type="button" onClick={onClick} className={`${cls} text-left hover:bg-white/10 transition-colors`}>
      {inner}
    </button>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Day-of-week × hour, sequential single hue. The backend counts in
 *  UTC; cells are shifted into the viewer's zone here. */
export function WeekHeatmap({ cells }: { cells: Array<{ dow: number; hour: number; count: number }> }) {
  const offsetH = Math.round(-new Date().getTimezoneOffset() / 60);
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const c of cells) {
    let hour = c.hour + offsetH;
    let dow = c.dow;
    if (hour >= 24) {
      hour -= 24;
      dow = (dow + 1) % 7;
    } else if (hour < 0) {
      hour += 24;
      dow = (dow + 6) % 7;
    }
    grid[dow][hour] += c.count;
  }
  const max = Math.max(1, ...grid.flat());
  const [hover, setHover] = useState<{ d: number; h: number } | null>(null);
  return (
    <div className="relative">
      <div className="grid gap-px" style={{ gridTemplateColumns: "2.2rem repeat(24, minmax(0, 1fr))" }}>
        <div />
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} className="text-[9px] text-slate-500 text-center leading-4">
            {h % 3 === 0 ? String(h).padStart(2, "0") : ""}
          </div>
        ))}
        {grid.map((row, d) => (
          <FragmentRow key={d} label={DOW[d]} row={row} d={d} max={max} setHover={setHover} />
        ))}
      </div>
      {hover && (
        <div className="absolute right-0 -top-6 text-xs text-slate-300 pointer-events-none">
          {DOW[hover.d]} {String(hover.h).padStart(2, "0")}:00 ·{" "}
          <span className="text-slate-100 tabular-nums">{fmtNum(grid[hover.d][hover.h])}</span>
        </div>
      )}
    </div>
  );
}

function FragmentRow({
  label,
  row,
  d,
  max,
  setHover,
}: {
  label: string;
  row: number[];
  d: number;
  max: number;
  setHover: (v: { d: number; h: number } | null) => void;
}) {
  return (
    <>
      <div className="text-[10px] text-slate-500 leading-4 pr-1">{label}</div>
      {row.map((v, h) => (
        <div
          key={h}
          className="h-4 rounded-[2px]"
          style={{
            backgroundColor:
              v === 0 ? "rgba(255,255,255,0.04)" : `rgba(57,135,229,${0.15 + 0.85 * (v / max)})`,
          }}
          onMouseEnter={() => setHover({ d, h })}
          onMouseLeave={() => setHover(null)}
          title={`${label} ${String(h).padStart(2, "0")}:00 · ${fmtNum(v)}`}
        />
      ))}
    </>
  );
}

export { NEUTRAL_SERIES };
