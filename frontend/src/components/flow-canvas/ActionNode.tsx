import { Handle, Position, NodeProps } from "@xyflow/react";

import { ActionSpec, FlowNode } from "../../lib/api";


export interface ActionNodeData extends Record<string, unknown> {
  node: FlowNode;
  spec: ActionSpec | undefined;
  canRemove: boolean;
  outgoingCount: number;
  onRemove: () => void;
  onAddChild: () => void;
}


/** A single action node on the canvas. */
export default function ActionNode({ data, selected }: NodeProps) {
  const d = data as ActionNodeData;
  const { node, spec } = d;
  const summary = summarize(node);

  return (
    <div
      className={`w-72 rounded-lg border-2 bg-slate-900 shadow-xl ${
        selected ? "border-sky-500" : "border-slate-700"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-slate-500 !w-2 !h-2" />
      <div className="px-3 py-2 bg-slate-900/80 border-b border-slate-700 rounded-t-md flex items-center gap-2">
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
          ACT
        </span>
        <span className="text-sm font-mono text-slate-100 truncate flex-1">
          {node.name}
        </span>
        <button
          className="nodrag text-xs px-1 text-slate-400 hover:text-rose-300 disabled:opacity-30 disabled:cursor-not-allowed"
          disabled={!d.canRemove}
          onClick={(e) => {
            e.stopPropagation();
            d.onRemove();
          }}
          title="Remove"
        >
          ×
        </button>
      </div>
      <div className="px-3 py-2 text-xs space-y-1">
        <div className="text-slate-400">
          action{" "}
          <span className="text-slate-100">
            {spec?.label ?? (
              <span className="text-rose-300">{node.action_type}</span>
            )}
          </span>
        </div>
        {summary && (
          <div className="text-slate-300 font-mono truncate">{summary}</div>
        )}
      </div>
      <div className="flex justify-center pb-1 pt-0">
        <button
          onClick={(e) => {
            e.stopPropagation();
            d.onAddChild();
          }}
          className="nodrag text-[10px] uppercase font-semibold text-sky-300 hover:underline"
          title={
            d.outgoingCount === 0
              ? "Add the next step"
              : "Branch — add another downstream step"
          }
        >
          + {d.outgoingCount === 0 ? "next step" : "branch"}
        </button>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-slate-500 !w-2 !h-2" />
    </div>
  );
}


function summarize(node: FlowNode): string | null {
  const cfg = node.config ?? {};
  if (node.action_type === "verkada_api_call") {
    const body = cfg.body;
    const hasBody = body && typeof body === "object" && Object.keys(body).length > 0;
    return hasBody ? "with body templated" : "endpoint configured";
  }
  if (node.action_type === "verkada_unlock_door") {
    const door = cfg.door_id;
    return typeof door === "string" && door
      ? `unlock ${door.slice(0, 8)}…`
      : "unlock door";
  }
  return null;
}
