import { useMemo } from "react";
import { Background, Edge, Node, ReactFlow } from "@xyflow/react";

import { ActionSpec, FlowEdge, FlowNode } from "../../lib/api";
import ActionNode from "./ActionNode";
import ConditionNode from "./ConditionNode";
import GlowEdge from "./GlowEdge";
import TriggerNode from "./TriggerNode";
import { COL_X, TRIGGER_ID, computeLayout } from "./layout";

/**
 * A proposed flow, drawn the way the editor draws it.
 *
 * The builder used to render its proposal as three JSON blocks, one of
 * which was a thousand-character Gemini prompt. That is the whole flow
 * in front of you and none of it legible: you cannot see at a glance
 * that this fires on a schedule, checks one thing and branches, which
 * is the only question you have before deciding to create it.
 *
 * Same node components and same layout function as the editor, so this
 * is a preview of the thing rather than a drawing of it. Nothing is
 * interactive — no handlers, no dragging, no selection — because there
 * is nothing here to change yet.
 */

const NODE_TYPES = {
  trigger: TriggerNode,
  action: ActionNode,
  condition: ConditionNode,
};
const EDGE_TYPES = { glow: GlowEdge };

const noop = () => {};

export default function FlowPreview({
  triggerType,
  triggerConfig,
  nodes,
  edges,
  specs,
  height = 340,
}: {
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  nodes: FlowNode[];
  edges: FlowEdge[];
  specs: Record<string, ActionSpec> | undefined;
  height?: number;
}) {
  const rf = useMemo(() => {
    const layout = computeLayout(nodes, edges);
    const rfNodes: Node[] = [
      {
        id: TRIGGER_ID,
        type: "trigger",
        position: { x: COL_X, y: 0 },
        data: {
          trigger_type: triggerType,
          trigger_config: triggerConfig,
          // No add-child affordance: this is a picture of a proposal,
          // and offering to edit something that does not exist yet
          // would be a button with nowhere to put the result.
          onAddChild: undefined,
          runActive: false,
        },
        draggable: false,
        selectable: false,
      },
      ...nodes.map<Node>((n) => ({
        id: n.id,
        type: n.kind === "condition" ? "condition" : "action",
        position: layout.get(n.id) ?? { x: COL_X, y: 200 },
        data: {
          node: n,
          spec: specs?.[n.action_type ?? ""],
          canRemove: false,
          outgoingCount: edges.filter((e) => e.source === n.id).length,
          onRemove: noop,
          onAddChild: undefined,
          // Deliberately not computed. A proposal always has empty
          // connection slots — they are bound at install — so every
          // node would wear a "needs config" badge, which is noise
          // rather than a warning.
          missingRequired: [],
        },
        draggable: false,
        selectable: false,
      })),
    ];
    const rfEdges: Edge[] = edges.map((e) => ({
      id: e.id,
      source: e.source === TRIGGER_ID ? TRIGGER_ID : e.source,
      target: e.target,
      type: "glow",
      data: { branch: e.branch ?? null },
      label: e.branch ?? undefined,
    }));
    return { rfNodes, rfEdges };
  }, [triggerType, triggerConfig, nodes, edges, specs]);

  return (
    <div
      style={{ height }}
      className="rounded-lg border border-white/10 bg-black/25 overflow-hidden"
    >
      <ReactFlow
        nodes={rf.rfNodes}
        edges={rf.rfEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag
        zoomOnScroll={false}
        preventScrolling={false}
      >
        <Background gap={18} size={1} color="rgba(255,255,255,0.06)" />
      </ReactFlow>
    </div>
  );
}
