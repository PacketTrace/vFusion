import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { apiGet, TriggerField } from "../lib/api";

interface PriorStep {
  name: string;
  output_sample: unknown;
}

interface Props {
  family: string;
  notificationType?: string;
  /** Steps that precede the one being configured. Their outputs become
   *  selectable as ``{{ steps.<name>.output.<path> }}``. */
  priorSteps?: PriorStep[];
  /** Called with the bare path. Caller wraps with {{ }}, quotes, etc. */
  onPick: (path: string) => void;
}

interface PickerRow {
  path: string;
  sample: unknown;
  type: string;
  group: string;
  /** Optional human-friendly suffix shown next to the path. Used to call
   *  out commonly-needed values like Gemini's analysis text. */
  label?: string;
}

export default function VariablePicker({
  family,
  notificationType,
  priorSteps = [],
  onPick,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const triggerFields = useQuery({
    queryKey: ["trigger-fields", family, notificationType],
    queryFn: () => {
      const params = new URLSearchParams();
      if (family) params.set("family", family);
      if (notificationType) params.set("notification_type", notificationType);
      return apiGet<TriggerField[]>(`/api/triggers/sample-fields?${params.toString()}`);
    },
    enabled: open,
    staleTime: 60_000,
  });

  const rows: PickerRow[] = [];
  // Pin commonly-needed values at the top. Right now that's any prior
  // step's `output.text` (Gemini analyze actions) — that's the answer
  // most users want to drop into a Helix Summary attribute.
  for (const step of priorSteps) {
    const sample = step.output_sample as Record<string, unknown> | null;
    if (sample && typeof sample === "object" && "text" in sample) {
      rows.push({
        path: `steps.${step.name}.output.text`,
        sample: sample.text,
        type: "string",
        group: "Pinned",
        label: "Gemini Summary",
      });
    }
  }
  for (const f of triggerFields.data ?? []) {
    rows.push({ path: f.path, sample: f.sample, type: f.type, group: "Trigger" });
  }
  for (const step of priorSteps) {
    flatten(step.output_sample, `steps.${step.name}.output`, (path, sample, type) => {
      rows.push({ path, sample, type, group: `Step "${step.name}"` });
    });
  }

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        className="text-[10px] px-2 py-1 rounded border border-slate-700 hover:border-sky-600 text-sky-300 whitespace-nowrap"
        title="Insert a value from the trigger or a prior step"
      >
        + variable
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-96 bg-slate-900 border border-slate-700 rounded-lg shadow-xl z-[70] max-h-80 overflow-auto">
          <div className="px-3 py-2 border-b border-slate-800 text-[11px] text-slate-400 sticky top-0 bg-slate-900">
            Click any path to insert it as <code>{`{{ … }}`}</code>.
          </div>
          {triggerFields.isLoading ? (
            <div className="p-3 text-xs text-slate-500">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="p-3 text-xs text-slate-500">
              No sample webhook yet for this trigger. Fire one to populate this list.
            </div>
          ) : (
            <PickerList
              rows={rows}
              onPick={(p) => {
                onPick(p);
                setOpen(false);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function PickerList({
  rows,
  onPick,
}: {
  rows: PickerRow[];
  onPick: (path: string) => void;
}) {
  const groups = new Map<string, PickerRow[]>();
  for (const r of rows) {
    if (!groups.has(r.group)) groups.set(r.group, []);
    groups.get(r.group)!.push(r);
  }
  return (
    <div>
      {[...groups.entries()].map(([group, items]) => (
        <div key={group}>
          <div className="px-3 py-1.5 bg-slate-900/80 text-[10px] font-bold uppercase tracking-wider text-slate-400">
            {group}{" "}
            <span className="text-slate-500 font-normal normal-case">
              ({items.length})
            </span>
          </div>
          <ul className="divide-y divide-slate-800/50">
            {items.map((f) => (
              <li
                key={f.path}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPick(f.path)}
                className="px-3 py-1.5 cursor-pointer hover:bg-slate-800/50 text-xs"
              >
                <div className="font-mono text-sky-300">
                  {f.path}
                  {f.label && (
                    <span className="ml-2 text-[10px] uppercase tracking-wider text-emerald-300 font-sans">
                      ({f.label})
                    </span>
                  )}
                </div>
                <div className="text-slate-400 truncate">
                  {formatSample(f.sample, f.type)}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function flatten(
  value: unknown,
  prefix: string,
  out: (path: string, sample: unknown, type: string) => void,
): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    out(prefix, `<array of ${value.length}>`, "array");
    if (value.length > 0) flatten(value[0], `${prefix}.0`, out);
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return;
  }
  out(prefix, value, typeof value);
}

function formatSample(sample: unknown, type: string): string {
  if (sample === null) return "null";
  if (sample === undefined) return "—";
  if (type === "array") return String(sample);
  if (typeof sample === "string") return `"${sample}"`;
  if (typeof sample === "object") return JSON.stringify(sample);
  return String(sample);
}
