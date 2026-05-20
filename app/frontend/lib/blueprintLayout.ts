/**
 * Auto-layout for the Blueprint canvas. Runs Dagre over the current
 * nodes + edges and returns nodes with computed positions.
 *
 * Why Dagre: the canvas's edges are dependency arrows (subnet → vpc,
 * instance → subnet, etc.) which form a DAG most of the time. Dagre's
 * ranked-layered layout maps that cleanly onto a left-to-right flow.
 * For ~50 nodes we'd run it in <50ms, which is fine for an on-demand
 * "Layout" button plus an auto-trigger after reloads.
 *
 * We don't use Dagre's positioning for ALL reloads — the user
 * positions nodes by drag, and those get persisted via the layout
 * sidecar. Auto-layout only fires when the canvas detects new
 * arrivals stuck at the origin (typical of AI-written resources that
 * don't include a position in their POST).
 */

import dagre from "dagre";
import type { Edge, Node } from "@xyflow/react";

/** Per-node bounding box used by Dagre. Width matches our resource-
 *  card sizing in `BlueprintCanvas.tsx`; height is a slight overshoot
 *  so the LR layout breathes a bit between rows. */
const NODE_WIDTH = 220;
const NODE_HEIGHT = 56;

export function autoLayoutNodes<TData extends Record<string, unknown>>(
  nodes: Node<TData>[],
  edges: Edge[],
): Node<TData>[] {
  if (nodes.length === 0) return nodes;

  const g = new dagre.graphlib.Graph();
  // LR (left-to-right) reads naturally for "X depends on Y" — sources
  // (VPC, IAM) on the left, consumers (subnets, instances) on the right.
  // `nodesep` is horizontal spacing within a rank, `ranksep` between
  // ranks; the chosen values keep the family-colored rails visible and
  // give arrows enough room to bend.
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 80, marginx: 30, marginy: 30 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) {
    g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const e of edges) {
    if (g.hasNode(e.source) && g.hasNode(e.target)) {
      g.setEdge(e.source, e.target);
    }
  }

  dagre.layout(g);

  return nodes.map((n) => {
    const pos = g.node(n.id);
    if (!pos) return n;
    // Dagre returns the center of the node; React Flow uses the
    // top-left corner. Translate.
    return {
      ...n,
      position: {
        x: Math.round(pos.x - NODE_WIDTH / 2),
        y: Math.round(pos.y - NODE_HEIGHT / 2),
      },
    };
  });
}

/** Detects "fresh AI-arrival" patterns: every node still parked at
 *  (0, 0). If the agent wrote multiple resources in one turn without
 *  positions, they pile up at the origin; auto-layout makes them
 *  readable. We don't trigger when even one node has a non-origin
 *  position — that's a sign the user has been arranging by hand.
 */
export function shouldAutoLayout<TData extends Record<string, unknown>>(
  nodeIds: string[],
  nodes: Node<TData>[],
): boolean {
  if (nodeIds.length === 0) return false;
  const matchingNew = nodes.filter((n) => nodeIds.includes(n.id));
  if (matchingNew.length === 0) return false;
  return matchingNew.every(
    (n) => n.position.x === 0 && n.position.y === 0,
  );
}
