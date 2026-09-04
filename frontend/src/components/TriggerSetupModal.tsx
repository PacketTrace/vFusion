import { useEffect, useRef, useState } from "react";

import { ScheduleConfigState } from "./ScheduleTriggerForm";
import { TriggerConfigState } from "./TriggerConfigForm";

/**
 * The one question a freshly-automated flow cannot answer for itself.
 *
 * Everything else carries over from the run that produced it — camera,
 * prompt, model, Helix mapping. What starts it does not: a one-shot
 * analysis was started by pressing a button, and that has no equivalent.
 * So the flow arrives with a placeholder trigger and this asks.
 *
 * Deliberately narrower than the trigger form behind it. Two choices and
 * one follow-up, chosen so the common cases need no thought; anything
 * beyond them is a click away in the panel this closes onto, which can
 * filter on any field and schedule daily or weekly. Asking everything
 * here would just be that form in a smaller box.
 */

const OBJECTS = [
  { value: "person", label: "A person" },
  { value: "vehicle", label: "A vehicle" },
  { value: "animal", label: "An animal" },
  { value: "", label: "Anything moving" },
];

const INTERVALS = [
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "hour" },
  { value: 360, label: "6 hours" },
  { value: 1440, label: "day" },
];

export default function TriggerSetupModal({
  cameraLabel,
  trigger,
  onApply,
  onClose,
}: {
  /** What to call the camera the analytic was built against. */
  cameraLabel: string;
  trigger: TriggerConfigState;
  onApply: (next: {
    triggerType: "verkada_webhook" | "schedule";
    trigger: TriggerConfigState;
    schedule?: ScheduleConfigState;
  }) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<"camera" | "schedule">("camera");
  const [objects, setObjects] = useState("person");
  const [everyMinutes, setEveryMinutes] = useState(60);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const apply = () => {
    if (kind === "schedule") {
      onApply({
        triggerType: "schedule",
        // The webhook config is handed back untouched. Switching to a
        // schedule should not throw away the camera filter — switching
        // back has to find it still there.
        trigger,
        schedule: {
          kind: "interval",
          everyMinutes,
          hour: 6,
          minute: 0,
          weekday: 0,
        },
      });
      return;
    }
    // Keep every filter the flow arrived with (the camera, chiefly) and
    // set only the object one, replacing any existing entry rather than
    // appending a second that would contradict it.
    const filters = trigger.filters.filter((f) => f.field !== "objects");
    if (objects) filters.push({ field: "objects", value: objects });
    onApply({
      triggerType: "verkada_webhook",
      trigger: {
        ...trigger,
        family: "camera",
        notificationType: "alert_rule_motion",
        filters,
      },
    });
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-lg border border-white/15 bg-[#0f1420] shadow-2xl">
        <div className="px-4 py-3 border-b border-white/10">
          <div className="text-sm font-semibold text-white">
            What should start this flow?
          </div>
          <p className="text-[11px] text-slate-400 mt-0.5">
            The camera, prompt, model and Helix mapping came over from your
            run. This is the only part a one-shot analysis had no answer for.
          </p>
        </div>

        <div className="p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <KindCard
              active={kind === "camera"}
              title="When the camera sees something"
              blurb={`Runs each time ${cameraLabel} reports motion.`}
              onClick={() => setKind("camera")}
            />
            <KindCard
              active={kind === "schedule"}
              title="On a schedule"
              blurb="Runs on a timer whether or not anything happened."
              onClick={() => setKind("schedule")}
            />
          </div>

          {kind === "camera" ? (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-1.5">
                Run when it detects
              </div>
              <div className="flex flex-wrap gap-2">
                {OBJECTS.map((o) => (
                  <button
                    key={o.label}
                    type="button"
                    onClick={() => setObjects(o.value)}
                    aria-pressed={objects === o.value}
                    className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${
                      objects === o.value
                        ? "border-sky-400/80 bg-sky-950/40 text-sky-100"
                        : "border-white/15 bg-white/5 text-slate-300 hover:border-white/35"
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-slate-500 mt-2">
                Narrower than "anything moving" means fewer runs and a smaller
                Gemini bill. You can change it, or filter on anything else, in
                the trigger panel behind this.
              </p>
            </div>
          ) : (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-1.5">
                Run every
              </div>
              <div className="flex flex-wrap gap-2">
                {INTERVALS.map((i) => (
                  <button
                    key={i.value}
                    type="button"
                    onClick={() => setEveryMinutes(i.value)}
                    aria-pressed={everyMinutes === i.value}
                    className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${
                      everyMinutes === i.value
                        ? "border-sky-400/80 bg-sky-950/40 text-sky-100"
                        : "border-white/15 bg-white/5 text-slate-300 hover:border-white/35"
                    }`}
                  >
                    {i.label}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-slate-500 mt-2">
                Daily and weekly schedules are in the trigger panel behind
                this.
              </p>
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-white/10 flex items-center justify-end gap-2">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded-md border border-white/15 text-slate-300 hover:bg-white/10"
          >
            I'll set it up myself
          </button>
          <button
            type="button"
            onClick={apply}
            className="text-xs px-3 py-1.5 rounded-md bg-sky-700 hover:bg-sky-600 text-white"
          >
            Set the trigger
          </button>
        </div>
        <p className="px-4 pb-3 text-[10px] text-slate-500">
          The flow stays switched off either way — nothing runs until you
          enable and save it.
        </p>
      </div>
    </div>
  );
}

function KindCard({
  active,
  title,
  blurb,
  onClick,
}: {
  active: boolean;
  title: string;
  blurb: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`text-left p-3 rounded-md border transition-colors ${
        active
          ? "border-sky-400/80 bg-sky-950/40"
          : "border-white/15 bg-white/5 hover:border-white/35"
      }`}
    >
      <div className="text-sm text-slate-100">{title}</div>
      <div className="text-[11px] text-slate-400 mt-0.5">{blurb}</div>
    </button>
  );
}
