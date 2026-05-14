import { Handle, Position, NodeProps } from "@xyflow/react";

import { FlowNode } from "../../lib/api";


export interface ConditionNodeData extends Record<string, unknown> {
  node: FlowNode;
  canRemove: boolean;
  onRemove: () => void;
  onAddBranch: (branch: "true" | "false") => void;
}


export default function ConditionNode({ data, selected }: NodeProps) {
  const d = data as ConditionNodeData;
  const cfg = d.node.config ?? {};
  const left = (cfg.left as string) ?? "";
  const op = (cfg.operator as string) ?? "equals";
  const right = (cfg.right as string) ?? "";

  return (
    <div
      className={`w-72 rounded-lg border-2 bg-slate-900 shadow-xl ${
        selected ? "border-amber-500" : "border-slate-700"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-slate-500 !w-2 !h-2" />
      <div className="px-3 py-2 bg-amber-950/60 border-b border-slate-700 rounded-t-md flex items-center gap-2">
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-900 text-amber-200">
          IF
        </span>
        <span className="text-sm font-mono text-slate-100 truncate flex-1">
          {d.node.name}
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
        <div className="font-mono text-slate-300 truncate" title={left}>
          {left || <span className="text-slate-600">(no left value)</span>}
        </div>
        <div className="font-mono text-slate-400">{op}</div>
        {!IS_UNARY[op] && (
          <div className="font-mono text-slate-300 truncate" title={right}>
            {right || <span className="text-slate-600">(no right value)</span>}
          </div>
        )}
      </div>
      <div className="flex justify-around items-center px-1 pb-1 pt-0 text-[10px] text-slate-400">
        <BranchHandle
          id="true"
          label="true"
          color="emerald"
          onAdd={() => d.onAddBranch("true")}
        />
        <BranchHandle
          id="false"
          label="false"
          color="rose"
          onAdd={() => d.onAddBranch("false")}
        />
      </div>
    </div>
  );
}


const IS_UNARY: Record<string, boolean> = { exists: true, not_exists: true };


function BranchHandle({
  id,
  label,
  color,
  onAdd,
}: {
  id: string;
  label: string;
  color: "emerald" | "rose";
  onAdd: () => void;
}) {
  const text = color === "emerald" ? "text-emerald-300" : "text-rose-300";
  return (
    <div className="relative flex flex-col items-center w-1/2">
      <button
        onClick={(e) => {
          e.stopPropagation();
          onAdd();
        }}
        className={`nodrag text-[10px] uppercase font-semibold ${text} hover:underline pb-2`}
        title={`Add step on the ${label} branch`}
      >
        + {label}
      </button>
      <Handle
        type="source"
        position={Position.Bottom}
        id={id}
        className="!bg-slate-500 !w-2 !h-2 !relative !translate-x-0 !translate-y-0"
      />
    </div>
  );
}
