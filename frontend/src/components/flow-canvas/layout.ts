/**
 * Where each node sits on the canvas.
 *
 * Shared between the editor and the read-only preview so a proposed
 * flow is laid out exactly as the saved one will be — a preview that
 * arranges itself differently is a preview of something else.
 */

import { FlowEdge, FlowNode } from "../../lib/api";

export const COL_X = 320;
export const ROW_Y = 200;
// Space left *between* nodes, rather than between their top edges.
export const ROW_GAP = 64;
// Used until React Flow reports what a node actually measured. Close to
// a plain two-line action card, so the first frame is roughly right and
// the settle is not a jump.
export const DEFAULT_NODE_H = 120;
export const TRIGGER_ID = "__trigger__";


export function computeLayout(
  nodes: FlowNode[],
  edges: FlowEdge[],
  heights: Record<string, number> = {},
): Map<string, { x: number; y: number }> {
  const depth = new Map<string, number>();
  const incoming = new Map<string, FlowEdge[]>();
  for (const e of edges) {
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target)!.push(e);
  }

  const visit = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const inc = incoming.get(id) ?? [];
    if (inc.length === 0) {
      depth.set(id, 0);
      return 0;
    }
    let max = 0;
    for (const e of inc) {
      max = Math.max(max, visit(e.source, seen) + 1);
    }
    depth.set(id, max);
    return max;
  };
  for (const n of nodes) visit(n.id);

  const byDepth = new Map<number, string[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(n.id);
  }

  const positions = new Map<string, { x: number; y: number }>();
  // The trigger is not in ``nodes`` — it sits at y=0 and is the thing
  // depth 0 has to clear.
  let y = (heights[TRIGGER_ID] ?? DEFAULT_NODE_H) + ROW_GAP;
  for (const d of [...byDepth.keys()].sort((a, b) => a - b)) {
    const ids = byDepth.get(d)!;
    const total = ids.length;
    ids.forEach((id, i) => {
      const xOffset = (i - (total - 1) / 2) * COL_X;
      positions.set(id, { x: COL_X + xOffset, y });
    });
    // The tallest node in a layer sets where the next one starts, so a
    // branch with one long node does not overlap its sibling's child.
    const tallest = Math.max(
      ...ids.map((id) => heights[id] ?? DEFAULT_NODE_H),
    );
    y += tallest + ROW_GAP;
  }
  return positions;
}
