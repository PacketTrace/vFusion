import { useEffect, useMemo, useState } from "react";


// EpochPicker
//
// Theme-clean inline date + time picker. Source of truth is unix
// epoch seconds. Three input modes that all converge on the same
// value:
//   1. Quick preset chips ("now", "5 min ago", "1 hour ago", …) —
//      most BYOA usage is "run this against what just happened" so
//      these are the common path.
//   2. A custom-rendered calendar grid + H:M:S steppers — the main
//      UI, fully styled to match the rest of the app (the native
//      datetime-local picker is unfixable).
//   3. A raw epoch-seconds input for when the user has the value
//      from a webhook payload and wants to paste it in.
// The resolved time is echoed in plain language below.

interface Props {
  value: number | null;
  onChange: (epoch: number | null) => void;
}


const PRESETS: { label: string; secondsAgo: number }[] = [
  { label: "now", secondsAgo: 0 },
  { label: "1m ago", secondsAgo: 60 },
  { label: "5m ago", secondsAgo: 5 * 60 },
  { label: "15m ago", secondsAgo: 15 * 60 },
  { label: "1h ago", secondsAgo: 60 * 60 },
  { label: "6h ago", secondsAgo: 6 * 60 * 60 },
  { label: "24h ago", secondsAgo: 24 * 60 * 60 },
];


const DAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];


function pad(n: number, w = 2): string {
  return n.toString().padStart(w, "0");
}


function isSameYMD(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}


// Build a 6-row × 7-col grid of Date objects covering the month that
// contains ``viewDate``. Leading/trailing cells come from the prior /
// next month so the grid is always 42 cells, matching the visual.
function monthGrid(viewDate: Date): Date[] {
  const first = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push(d);
  }
  return cells;
}


export default function EpochPicker({ value, onChange }: Props) {
  // The selected moment broken into its components — kept as local
  // state so the user can adjust H / M / S without immediately re-
  // parsing. Reconciled with the parent value via the effect below.
  const initial = value !== null ? new Date(value * 1000) : new Date();
  const [year, setYear] = useState(initial.getFullYear());
  const [month, setMonth] = useState(initial.getMonth());
  const [day, setDay] = useState(initial.getDate());
  const [hour, setHour] = useState(initial.getHours());
  const [minute, setMinute] = useState(initial.getMinutes());
  const [second, setSecond] = useState(initial.getSeconds());
  // ``viewMonth`` controls which month grid is on screen — independent
  // from the selected day so the user can browse forward/back without
  // changing their selection.
  const [viewYear, setViewYear] = useState(initial.getFullYear());
  const [viewMonth, setViewMonth] = useState(initial.getMonth());
  const [epochText, setEpochText] = useState<string>(
    value === null ? "" : String(value),
  );

  // When the parent value changes from outside (preset click, "Run it
  // back" hydration, etc.), rebuild the broken-out components.
  useEffect(() => {
    if (value === null) {
      setEpochText("");
      return;
    }
    const d = new Date(value * 1000);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
    setDay(d.getDate());
    setHour(d.getHours());
    setMinute(d.getMinutes());
    setSecond(d.getSeconds());
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
    setEpochText(String(value));
  }, [value]);

  const pushParts = (parts: Partial<{
    year: number; month: number; day: number;
    hour: number; minute: number; second: number;
  }>) => {
    const y = parts.year ?? year;
    const mo = parts.month ?? month;
    const d = parts.day ?? day;
    const h = parts.hour ?? hour;
    const mi = parts.minute ?? minute;
    const s = parts.second ?? second;
    const date = new Date(y, mo, d, h, mi, s);
    onChange(Math.floor(date.getTime() / 1000));
  };

  const pushEpoch = (raw: string) => {
    setEpochText(raw);
    const n = Number(raw.trim());
    if (raw.trim() === "" || Number.isNaN(n) || n <= 0) return;
    onChange(Math.floor(n));
  };

  const applyPreset = (secondsAgo: number) => {
    onChange(Math.floor(Date.now() / 1000) - secondsAgo);
  };

  const cells = useMemo(
    () => monthGrid(new Date(viewYear, viewMonth, 1)),
    [viewYear, viewMonth],
  );
  const selected = new Date(year, month, day, hour, minute, second);
  const today = new Date();

  const human =
    value !== null && !Number.isNaN(new Date(value * 1000).getTime())
      ? new Date(value * 1000).toLocaleString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
        })
      : null;

  return (
    <div className="space-y-3">
      {/* Quick presets */}
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => applyPreset(p.secondsAgo)}
            className="text-[11px] px-2 py-1 rounded border border-white/15 hover:border-sky-500 hover:bg-white/5 text-slate-300"
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="grid md:grid-cols-[auto,1fr] gap-3">
        {/* Calendar grid */}
        <div className="bg-white/5 border border-white/15 rounded-lg p-3 w-72">
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              onClick={() => {
                const next = new Date(viewYear, viewMonth - 1, 1);
                setViewYear(next.getFullYear());
                setViewMonth(next.getMonth());
              }}
              className="text-slate-300 hover:text-white px-1.5 py-0.5"
              aria-label="previous month"
            >
              ◀
            </button>
            <div className="text-sm font-medium text-slate-100">
              {MONTH_LABELS[viewMonth]} {viewYear}
            </div>
            <button
              type="button"
              onClick={() => {
                const next = new Date(viewYear, viewMonth + 1, 1);
                setViewYear(next.getFullYear());
                setViewMonth(next.getMonth());
              }}
              className="text-slate-300 hover:text-white px-1.5 py-0.5"
              aria-label="next month"
            >
              ▶
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 mb-1">
            {DAY_LABELS.map((d) => (
              <div
                key={d}
                className="text-[10px] uppercase text-slate-500 text-center"
              >
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((d, i) => {
              const inMonth = d.getMonth() === viewMonth;
              const isSelected = isSameYMD(d, selected);
              const isToday = isSameYMD(d, today);
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    setYear(d.getFullYear());
                    setMonth(d.getMonth());
                    setDay(d.getDate());
                    setViewYear(d.getFullYear());
                    setViewMonth(d.getMonth());
                    pushParts({
                      year: d.getFullYear(),
                      month: d.getMonth(),
                      day: d.getDate(),
                    });
                  }}
                  className={`text-xs py-1 rounded transition-colors ${
                    isSelected
                      ? "bg-sky-600 text-white font-semibold"
                      : isToday
                        ? "bg-white/10 text-slate-100"
                        : inMonth
                          ? "text-slate-200 hover:bg-white/10"
                          : "text-slate-600 hover:bg-white/5"
                  }`}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
        </div>

        {/* Time steppers */}
        <div className="bg-white/5 border border-white/15 rounded-lg p-3 flex flex-col">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">
            Time
          </div>
          <div className="flex items-center gap-2 justify-center">
            <Stepper
              value={hour}
              min={0}
              max={23}
              wrap
              onChange={(v) => {
                setHour(v);
                pushParts({ hour: v });
              }}
              label="hours"
            />
            <div className="text-2xl text-slate-500 pb-1">:</div>
            <Stepper
              value={minute}
              min={0}
              max={59}
              wrap
              onChange={(v) => {
                setMinute(v);
                pushParts({ minute: v });
              }}
              label="minutes"
            />
            <div className="text-2xl text-slate-500 pb-1">:</div>
            <Stepper
              value={second}
              min={0}
              max={59}
              wrap
              onChange={(v) => {
                setSecond(v);
                pushParts({ second: v });
              }}
              label="seconds"
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5 justify-center">
            <TimeChip label="Midnight" onClick={() => pushTime(0, 0, 0)} />
            <TimeChip label="6 AM" onClick={() => pushTime(6, 0, 0)} />
            <TimeChip label="Noon" onClick={() => pushTime(12, 0, 0)} />
            <TimeChip label="6 PM" onClick={() => pushTime(18, 0, 0)} />
          </div>
          <div className="text-[10px] text-slate-500 mt-3 text-center">
            24-hour clock · local time
          </div>
        </div>
      </div>

      {/* Resolved + epoch escape hatch */}
      <div className="flex items-start gap-3 flex-wrap">
        <div className="text-xs flex-1 min-w-[18rem]">
          {human ? (
            <>
              → <span className="text-slate-100">{human}</span>{" "}
              <span className="text-slate-500">(epoch {value})</span>
            </>
          ) : (
            <span className="text-slate-500">
              Pick a date + time or paste an epoch below.
            </span>
          )}
        </div>
        <label className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">
            or paste epoch
          </span>
          <input
            value={epochText}
            onChange={(e) => pushEpoch(e.target.value)}
            placeholder="1778620517"
            inputMode="numeric"
            className="w-44 px-2 py-1 rounded bg-white/5 border border-white/15 text-xs font-mono"
          />
        </label>
      </div>
    </div>
  );

  // ----- helpers -----

  function pushTime(h: number, m: number, s: number) {
    setHour(h);
    setMinute(m);
    setSecond(s);
    pushParts({ hour: h, minute: m, second: s });
  }
}


function Stepper({
  value,
  min,
  max,
  wrap,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  wrap?: boolean;
  onChange: (v: number) => void;
  label: string;
}) {
  const clamp = (n: number) => {
    if (wrap) {
      const range = max - min + 1;
      return ((((n - min) % range) + range) % range) + min;
    }
    return Math.max(min, Math.min(max, n));
  };
  return (
    <div className="flex flex-col items-center">
      <button
        type="button"
        onClick={() => onChange(clamp(value + 1))}
        className="text-slate-400 hover:text-white text-xs"
        aria-label={`increment ${label}`}
      >
        ▲
      </button>
      <input
        type="number"
        value={pad(value)}
        min={min}
        max={max}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!Number.isNaN(v)) onChange(clamp(v));
        }}
        className="w-14 text-center px-1 py-1 rounded bg-white/5 border border-white/15 text-lg font-mono text-slate-100 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      <button
        type="button"
        onClick={() => onChange(clamp(value - 1))}
        className="text-slate-400 hover:text-white text-xs"
        aria-label={`decrement ${label}`}
      >
        ▼
      </button>
    </div>
  );
}


function TimeChip({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[11px] px-2 py-1 rounded border border-white/15 hover:border-sky-500 hover:bg-white/5 text-slate-300"
    >
      {label}
    </button>
  );
}
