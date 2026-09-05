import { useMemo, useState } from "react";

/**
 * A moment, entered as a date and time rather than as an epoch.
 *
 * Verkada takes these as integers, which is fine for a machine and
 * hostile to a person: converting "9am yesterday" by hand is how you
 * end up querying 1970 or the wrong hour, and both come back as an
 * empty result rather than an error.
 *
 * The zone is explicit and shown, because it is the part that goes
 * wrong silently. Verkada's own guidance is that a wall-clock time
 * means the camera's local time — so a picker that quietly assumed the
 * browser's zone would be right in one office and an hour out in the
 * next, with nothing on screen to say which.
 */

const ZONES: string[] = (() => {
  const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const common = [
    browser,
    "UTC",
    "America/Los_Angeles",
    "America/Denver",
    "America/Chicago",
    "America/New_York",
    "Europe/London",
    "Europe/Berlin",
    "Asia/Tokyo",
    "Australia/Sydney",
  ];
  return [...new Set(common.filter(Boolean))];
})();

/** The zone's offset from UTC, in ms, at a given instant. */
function offsetAt(utcMs: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") === 24 ? 0 : get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - utcMs;
}

/**
 * A wall-clock string in a named zone, as epoch seconds.
 *
 * Two passes, not one: the offset depends on the instant, and the
 * instant is what is being solved for. One correction is enough
 * everywhere except the hour a DST change lands in, and the second
 * settles that too.
 */
export function zonedToEpoch(local: string, zone: string): number | null {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi] = m.map(Number) as unknown as number[];
  const naive = Date.UTC(Y, Mo - 1, D, H, Mi);
  let guess = naive;
  for (let i = 0; i < 2; i++) guess = naive - offsetAt(guess, zone);
  return Math.floor(guess / 1000);
}

function epochToZoned(epochSec: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(epochSec * 1000));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = g("hour") === "24" ? "00" : g("hour");
  return `${g("year")}-${g("month")}-${g("day")}T${hour}:${g("minute")}`;
}

export default function EpochInput({
  value,
  onChange,
  milliseconds,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Fields named *_ms take epoch milliseconds. Getting this wrong is a
   *  thousandfold error that lands in 1970 and returns nothing. */
  milliseconds?: boolean;
}) {
  const [zone, setZone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [raw, setRaw] = useState(false);

  const asEpochSec = useMemo(() => {
    const n = Number(value);
    if (!value || Number.isNaN(n)) return null;
    return milliseconds ? Math.floor(n / 1000) : n;
  }, [value, milliseconds]);

  if (raw) {
    return (
      <div className="space-y-1">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={milliseconds ? "epoch milliseconds" : "epoch seconds"}
          className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm font-mono"
        />
        <button
          type="button"
          onClick={() => setRaw(false)}
          className="text-[11px] text-sky-400 hover:text-sky-300"
        >
          pick a date and time instead
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <input
          type="datetime-local"
          value={asEpochSec != null ? epochToZoned(asEpochSec, zone) : ""}
          onChange={(e) => {
            const sec = zonedToEpoch(e.target.value, zone);
            if (sec == null) {
              onChange("");
              return;
            }
            onChange(String(milliseconds ? sec * 1000 : sec));
          }}
          className="flex-1 px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
        />
        <select
          value={zone}
          onChange={(e) => setZone(e.target.value)}
          title="The zone the time above is in. Verkada reads wall-clock times as the camera's local time."
          className="px-2 py-1.5 rounded bg-white/5 border border-white/15 text-xs max-w-[11rem]"
        >
          {ZONES.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-[10px] text-slate-600 font-mono">
          {value ? `${value}${milliseconds ? " ms" : " s"}` : "not set"}
        </span>
        <button
          type="button"
          onClick={() =>
            onChange(
              String(
                milliseconds ? Date.now() : Math.floor(Date.now() / 1000),
              ),
            )
          }
          className="text-[11px] text-sky-400 hover:text-sky-300"
        >
          now
        </button>
        <button
          type="button"
          onClick={() => setRaw(true)}
          className="text-[11px] text-slate-500 hover:text-slate-300"
        >
          type the epoch
        </button>
      </div>
    </div>
  );
}
