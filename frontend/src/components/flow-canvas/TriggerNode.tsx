import { Handle, Position, NodeProps } from "@xyflow/react";

import { Flow } from "../../lib/api";


export interface TriggerNodeData extends Record<string, unknown> {
  trigger_type?: string;
  trigger_config: Flow["trigger_config"];
  onAddChild: () => void;
}


const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];


export default function TriggerNode({ data, selected }: NodeProps) {
  const d = data as TriggerNodeData;
  const isSchedule = d.trigger_type === "schedule";
  const cfg = d.trigger_config ?? {};

  return (
    <div
      className={`w-72 rounded-lg border-2 bg-slate-900 shadow-xl ${
        selected ? "border-sky-500" : "border-slate-700"
      }`}
    >
      <div className="px-3 py-2 bg-sky-950/60 border-b border-slate-700 rounded-t-md flex items-center gap-2">
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-900 text-sky-200">
          TRIGGER
        </span>
        <span className="text-sm font-medium text-slate-100">
          {isSchedule ? "Schedule" : "Verkada webhook"}
        </span>
      </div>
      {isSchedule ? (
        <ScheduleSummary cfg={cfg} />
      ) : (
        <WebhookSummary cfg={cfg} />
      )}
      <div className="flex justify-center pb-1 pt-0">
        <button
          onClick={(e) => {
            e.stopPropagation();
            d.onAddChild();
          }}
          className="nodrag text-[10px] uppercase font-semibold text-sky-300 hover:underline"
          title="Add the first step"
        >
          + start
        </button>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-slate-500 !w-2 !h-2" />
    </div>
  );
}


function pad(n: number): string {
  return n.toString().padStart(2, "0");
}


function ScheduleSummary({ cfg }: { cfg: Flow["trigger_config"] }) {
  const kind = (cfg as Record<string, unknown>).kind;
  if (kind === "interval") {
    const every = Number((cfg as Record<string, unknown>).every_minutes) || 0;
    return (
      <div className="px-3 py-2 text-xs space-y-1">
        <div className="text-slate-400">
          every <span className="text-slate-100 font-mono">{every} min</span>
        </div>
      </div>
    );
  }
  if (kind === "daily" || kind === "weekly") {
    const hour = Number((cfg as Record<string, unknown>).hour) || 0;
    const minute = Number((cfg as Record<string, unknown>).minute) || 0;
    const weekday = Number((cfg as Record<string, unknown>).weekday) || 0;
    return (
      <div className="px-3 py-2 text-xs space-y-1">
        <div className="text-slate-400">
          {kind === "weekly" && (
            <>
              weekly on{" "}
              <span className="text-slate-100 font-mono">
                {WEEKDAYS[weekday]}
              </span>
              {" at "}
            </>
          )}
          {kind === "daily" && "daily at "}
          <span className="text-slate-100 font-mono">
            {pad(hour)}:{pad(minute)} UTC
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="px-3 py-2 text-xs text-slate-500">
      (no schedule configured)
    </div>
  );
}


function WebhookSummary({ cfg }: { cfg: Flow["trigger_config"] }) {
  const family = (cfg as Record<string, unknown>).family ?? "(any)";
  const nt = (cfg as Record<string, unknown>).notification_type;
  const filters = (cfg as Record<string, unknown>).filters ?? {};
  const filterEntries = Object.entries(filters as Record<string, unknown>);
  return (
    <div className="px-3 py-2 text-xs space-y-1">
      <div className="text-slate-400">
        family <span className="text-slate-100 font-mono">{String(family)}</span>
      </div>
      {typeof nt === "string" && nt && (
        <div className="text-slate-400">
          type <span className="text-slate-100 font-mono">{nt}</span>
        </div>
      )}
      {filterEntries.length > 0 && (
        <div className="text-slate-400">
          filters:
          <ul className="ml-2 mt-0.5 space-y-0.5">
            {filterEntries.map(([k, v]) => (
              <li key={k} className="font-mono text-slate-300">
                {k} == "{String(v)}"
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
