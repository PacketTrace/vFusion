import { Flow } from "../lib/api";
import { ZONES } from "./EpochInput";


// Schedule trigger config. Three preset kinds — no free-form cron
// expression, since the UI for that is its own rabbit hole and we
// don't need the flexibility yet.

export interface ScheduleConfigState {
  kind: "interval" | "daily" | "weekly";
  everyMinutes: number; // for interval
  hour: number; // for daily / weekly (0-23)
  minute: number; // for daily / weekly (0-59)
  weekday: number; // for weekly (0=Monday … 6=Sunday)
  /** IANA zone the hour is meant in. "Every morning at 9" means nine
   *  where you are, and has to keep meaning that when the clocks
   *  change — which is why this is a zone name and not an offset. */
  tz: string;
}


/** The browser's own zone. Nobody sets a schedule for somewhere they
 *  are not, and asking is a question with an obvious answer. */
const LOCAL_TZ =
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const DEFAULT: ScheduleConfigState = {
  kind: "interval",
  everyMinutes: 60,
  hour: 6,
  minute: 0,
  weekday: 0,
  tz: LOCAL_TZ,
};


export function scheduleStateFromConfig(
  c: Flow["trigger_config"] | undefined,
): ScheduleConfigState {
  if (!c || typeof c !== "object") return { ...DEFAULT };
  const kind = (c as Record<string, unknown>).kind;
  return {
    kind:
      kind === "daily" || kind === "weekly" ? kind : "interval",
    everyMinutes:
      Number((c as Record<string, unknown>).every_minutes) || DEFAULT.everyMinutes,
    hour: clampInt((c as Record<string, unknown>).hour, 0, 23, DEFAULT.hour),
    minute: clampInt((c as Record<string, unknown>).minute, 0, 59, DEFAULT.minute),
    weekday: clampInt((c as Record<string, unknown>).weekday, 0, 6, DEFAULT.weekday),
    // A flow saved before zones existed has no tz and has been firing
    // in UTC. Showing it as local would relabel its schedule by several
    // hours without changing when it runs — so it keeps saying UTC
    // until somebody edits it.
    tz:
      typeof (c as Record<string, unknown>).tz === "string" &&
      (c as Record<string, unknown>).tz
        ? ((c as Record<string, unknown>).tz as string)
        : "UTC",
  };
}


export function scheduleStateToConfig(
  s: ScheduleConfigState,
): Flow["trigger_config"] {
  if (s.kind === "interval") {
    return { kind: "interval", every_minutes: Math.max(1, s.everyMinutes) };
  }
  if (s.kind === "daily") {
    return { kind: "daily", hour: s.hour, minute: s.minute, tz: s.tz };
  }
  return {
    kind: "weekly",
    hour: s.hour,
    minute: s.minute,
    weekday: s.weekday,
    tz: s.tz,
  };
}


function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}


const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];


interface Props {
  value: ScheduleConfigState;
  onChange: (next: ScheduleConfigState) => void;
}


export default function ScheduleTriggerForm({ value, onChange }: Props) {
  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs font-medium text-slate-300 mb-1">
          Schedule kind <span className="text-rose-400">*</span>
        </div>
        <div className="flex gap-2">
          <KindBtn
            active={value.kind === "interval"}
            onClick={() => onChange({ ...value, kind: "interval" })}
            label="Every N min"
          />
          <KindBtn
            active={value.kind === "daily"}
            onClick={() => onChange({ ...value, kind: "daily" })}
            label="Daily"
          />
          <KindBtn
            active={value.kind === "weekly"}
            onClick={() => onChange({ ...value, kind: "weekly" })}
            label="Weekly"
          />
        </div>
      </div>

      {value.kind === "interval" && (
        <Field
          label="Every (minutes)"
          help="Fires this often after the last run. Worker checks every minute, so the granularity floor is ~60s."
          required
        >
          <input
            type="number"
            min={1}
            value={value.everyMinutes}
            onChange={(e) =>
              onChange({
                ...value,
                everyMinutes: Math.max(1, Number(e.target.value) || 1),
              })
            }
            className="w-32 px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
          />
        </Field>
      )}

      {(value.kind === "daily" || value.kind === "weekly") && (
        <>
          {value.kind === "weekly" && (
            <Field label="Weekday" required>
              <select
                value={value.weekday}
                onChange={(e) =>
                  onChange({ ...value, weekday: Number(e.target.value) })
                }
                className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
              >
                {WEEKDAYS.map((w, i) => (
                  <option key={w} value={i}>
                    {w}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field
            label="Time of day"
            required
            help={
              value.tz === "UTC"
                ? "24-hour. This flow was saved before schedules carried a zone, so it is still firing in UTC — pick your own to change that."
                : `24-hour, ${value.tz.replace(/_/g, " ")}. Follows the clocks, so it stays at this hour through daylight saving.`
            }
          >
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={0}
                max={23}
                value={value.hour}
                onChange={(e) =>
                  onChange({
                    ...value,
                    hour: clampInt(e.target.value, 0, 23, value.hour),
                  })
                }
                className="w-16 px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm font-mono text-center"
              />
              <span className="text-slate-500">:</span>
              <input
                type="number"
                min={0}
                max={59}
                value={value.minute}
                onChange={(e) =>
                  onChange({
                    ...value,
                    minute: clampInt(e.target.value, 0, 59, value.minute),
                  })
                }
                className="w-16 px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm font-mono text-center"
              />
              {/* Beside the time, not in an "advanced" section. Nobody
                  thinks in UTC, and a schedule labelled with the wrong
                  zone runs at the wrong hour while looking correct. */}
              <select
                value={value.tz}
                onChange={(e) => onChange({ ...value, tz: e.target.value })}
                className="flex-1 min-w-0 px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
              >
                {[...new Set([value.tz, ...ZONES])].map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
          </Field>
        </>
      )}

      <div className="text-[11px] text-slate-500">
        Trigger context provides{" "}
        <code className="text-slate-300">{`{{ trigger.fired_at }}`}</code>{" "}
        (unix seconds when the tick fired) and{" "}
        <code className="text-slate-300">{`{{ trigger.kind }}`}</code>.
      </div>
    </div>
  );
}


function KindBtn({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 px-3 py-1.5 rounded border text-xs ${
        active
          ? "bg-sky-950/50 border-sky-500 text-sky-100"
          : "bg-white/5 border-white/15 text-slate-300 hover:border-sky-500"
      }`}
    >
      {label}
    </button>
  );
}


function Field({
  label,
  required,
  help,
  children,
}: {
  label: string;
  required?: boolean;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-xs font-medium text-slate-300 mb-1">
        {label}
        {required && <span className="text-rose-400 ml-1">*</span>}
      </div>
      {children}
      {help && <div className="text-xs text-slate-500 mt-1">{help}</div>}
    </label>
  );
}
