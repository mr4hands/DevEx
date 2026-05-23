/**
 * Auto-layout for the Blueprint canvas. Runs Dagre over the current
 * nodes + edges and returns nodes with computed positions.
 *
 * Why Dagre: the canvas's edges are dependency arrows (subnet → vpc,
 * instance → subnet, etc.) which form a DAG most of the time. Dagre's
 * ranked-layered layout maps that cleanly onto a left-to-right flow.
 * For ~50 nodes we'd run it in <50ms, which is fine for an on-demand
 * "Layout" button plus the canvas's auto-layout on every reload.
 *
 * The overlay model has no position sidecar — `/api/blueprint/resources`
 * returns no coordinates — so the canvas re-runs this on each load to keep
 * the graph readable rather than piling server nodes at the origin.
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
