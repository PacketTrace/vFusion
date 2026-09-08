import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { apiGet, TriggerField } from "../lib/api";
import { describeRef, formatSample } from "../lib/templateRefs";

interface PriorStep {
  name: string;
  label?: string;
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
  /** Wider trigger, for a field that is nothing but a picker. */
  label?: string;
}

interface PickerRow {
  path: string;
  sample: unknown;
  type: string;
  group: string;
  /** "obstructed", "camera id" — what a person calls it. */
  name: string;
  pinned?: boolean;
}

/**
 * Pick a value from the event or a prior step, by what it is called
 * rather than by its path. The path is still shown, small, because it
 * is what gets written; the name is what gets read.
 */
export default function VariablePicker({
  family,
  notificationType,
  priorSteps = [],
  onPick,
  label = "+ variable",
}: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ("");
    const t = window.setTimeout(() => searchRef.current?.focus(), 0);
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", handler);
      window.removeEventListener("keydown", onKey);
    };
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

  const rows = useMemo(() => {
    const out: PickerRow[] = [];
    const steps = priorSteps.map((s) => ({ name: s.name, label: s.label }));
    for (const step of priorSteps) {
      const sample = step.output_sample as Record<string, unknown> | null;
      const origin = step.label || step.name;
      if (sample && typeof sample === "object" && "text" in sample) {
        out.push({
          path: `steps.${step.name}.output.text`,
          sample: sample.text,
          type: "string",
          group: origin,
          name: "the answer",
          pinned: true,
        });
      }
      if (sample && typeof sample === "object" && sample.json && typeof sample.json === "object") {
        for (const [k, v] of Object.entries(sample.json as Record<string, unknown>)) {
          out.push({
            path: `steps.${step.name}.output.json.${k}`,
            sample: v,
            type: typeof v,
            group: origin,
            name: describeRef(`steps.${step.name}.output.json.${k}`, steps).field,
            pinned: true,
          });
        }
      }
    }
    for (const f of triggerFields.data ?? []) {
      out.push({
        path: f.path,
        sample: f.sample,
        type: f.type,
        group: "This event",
        name: describeRef(f.path, steps).field,
      });
    }
    for (const step of priorSteps) {
      const origin = step.label || step.name;
      flatten(step.output_sample, `steps.${step.name}.output`, (path, sample, type) => {
        if (out.some((r) => r.path === path)) return;
        out.push({ path, sample, type, group: origin, name: describeRef(path, steps).field });
      });
    }
    return out;
  }, [priorSteps, triggerFields.data]);

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? rows.filter(
        (r) =>
          r.name.toLowerCase().includes(needle) ||
          r.path.toLowerCase().includes(needle) ||
          r.group.toLowerCase().includes(needle) ||
          formatSample(r.sample).toLowerCase().includes(needle),
      )
    : rows;

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        className="text-[10px] px-2 py-1 rounded border border-slate-700 hover:border-sky-600 text-sky-300 whitespace-nowrap"
        title="Insert a value from the event or a previous step"
        aria-expanded={open}
      >
        {label}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-[26rem] bg-slate-900 border border-slate-700 rounded-lg shadow-xl z-[70] max-h-96 flex flex-col origin-top-right variable-picker-in">
          <div className="p-2 border-b border-slate-800 sticky top-0 bg-slate-900 rounded-t-lg">
            <input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name, value or path…"
              className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-xs focus:outline-none focus:border-sky-600"
            />
          </div>
          <div className="overflow-auto">
            {triggerFields.isLoading ? (
              <div className="p-3 text-xs text-slate-500">Loading…</div>
            ) : shown.length === 0 ? (
              <div className="p-3 text-xs text-slate-500">
                {rows.length === 0
                  ? "Nothing to pick from yet. Fire the trigger once, or run a previous step, and its fields appear here."
                  : `Nothing matches "${q}".`}
              </div>
            ) : (
              <PickerList
                rows={shown}
                onPick={(p) => {
                  onPick(p);
                  setOpen(false);
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PickerList({ rows, onPick }: { rows: PickerRow[]; onPick: (path: string) => void }) {
  const groups = new Map<string, PickerRow[]>();
  for (const r of rows) {
    if (!groups.has(r.group)) groups.set(r.group, []);
    groups.get(r.group)!.push(r);
  }
  // The event first, then steps in the order they were added.
  const ordered = [...groups.entries()].sort(([a], [b]) =>
    a === "This event" ? -1 : b === "This event" ? 1 : 0,
  );
  return (
    <div>
      {ordered.map(([group, items]) => (
        <div key={group}>
          <div className="px-3 py-1.5 bg-slate-900/80 text-[10px] font-bold uppercase tracking-wider text-slate-400 sticky top-0">
            {group}
          </div>
          <ul className="divide-y divide-slate-800/50">
            {items.map((f) => (
              <li
                key={f.path}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPick(f.path)}
                className="px-3 py-1.5 cursor-pointer hover:bg-slate-800/60 text-xs"
                title={`{{ ${f.path} }}`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className={`truncate ${f.pinned ? "text-emerald-200" : "text-slate-100"}`}>{f.name}</span>
                  <span className="text-slate-400 truncate max-w-[55%] text-right">{formatSample(f.sample)}</span>
                </div>
                <div className="font-mono text-[10px] text-slate-500 truncate">{f.path}</div>
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
