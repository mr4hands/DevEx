"use client";

import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";

import { fetchBlueprintResources, patchBlueprintLayout } from "@/lib/api";
import {
  autoLayoutNodes,
  shouldAutoLayout,
} from "@/lib/blueprintLayout";
import {
  FAMILY_CLASSES,
  familyOf,
} from "@/lib/resourceFamilies";
import {
  PALETTE,
  PALETTE_DRAG_TYPE,
  type PaletteItem,
} from "@/lib/blueprintPalette";
import type {
  BlueprintBlockInstance,
  BlueprintEdge,
  BlueprintResource,
} from "@/lib/types";

/**
 * The Blueprint canvas — drag resource tiles from the palette onto the
 * grid to plan an OpenTofu workspace visually.
 *
 * Phase 3 (this PR): the canvas is round-trippable. On mount + after
 * every Save, it fetches `/api/blueprint/resources` and reconciles
 * the React Flow state with what's on disk. Existing resources load
 * with their saved attributes + positions; dependency edges are
 * derived from inter-resource references in the HCL.
 *
 * Phase 4+ will add nested-block editing, auto-layout for newly-
 * loaded nodes, and a polished delete-node interaction.
 */
export type BlueprintNodeData = {
  resourceType: string;       // aws_s3_bucket
  name: string;               // HCL block label / file basename
  family: string;             // family color/monogram
  monogram: string;
  /** Pre-existing attribute values loaded from disk. The drawer's
   *  form uses these to pre-populate when an existing node is
   *  selected. Empty for newly-dropped nodes. */
  attributes?: Record<string, unknown>;
  /** Nested blocks (`versioning`, `lifecycle_rule`, etc.) loaded from
   *  disk, alongside `attributes`. Empty for fresh drops. */
  blocks?: Record<string, BlueprintBlockInstance[]>;
  /** When set, the backend couldn't parse this resource's `.tf` file.
   *  The drawer shows the error + a Delete button instead of the form,
   *  so the user can recover from a malformed write. */
  parseError?: string;
  /** Original on-disk filename when known. Used as a fallback target
   *  for Delete on parse-error nodes. */
  filename?: string;
  /** Briefly true on nodes that just arrived from a reload (typically
   *  the AI agent wrote HCL). The canvas pulses an amber ring around
   *  them, then clears the flag after a short window so the cue
   *  doesn't linger on the next interaction. */
  justArrived?: boolean;
} & Record<string, unknown>;  // index signature satisfies React Flow's Node constraint

export type BlueprintNode = Node<BlueprintNodeData>;

export type RenameEvent = { nodeId: string; newName: string };

export function BlueprintCanvas({
  selectedNodeId,
  onSelectNode,
  renameEvent,
  onRenameConsumed,
  reloadKey,
  onCanvasNodeDelete,
}: {
  selectedNodeId: string | null;
  onSelectNode: (node: BlueprintNode | null) => void;
  /** Set by the parent after a successful Save in the drawer. The
   *  canvas updates the matching node's label and then signals back
   *  via `onRenameConsumed`. */
  renameEvent?: RenameEvent | null;
  onRenameConsumed?: () => void;
  /** Bumping this triggers a re-fetch of `/api/blueprint/resources`.
   *  Used by the parent after Save or Delete so disk-side changes
   *  reflect on the canvas. */
  reloadKey?: number;
  /** Called when React Flow's built-in delete gesture fires (Backspace
   *  or Delete key) — must resolve before the node leaves the canvas
   *  so the disk-side delete + the visual removal stay consistent.
   *  Reject the promise to cancel the canvas removal. */
  onCanvasNodeDelete?: (node: BlueprintNode) => Promise<void>;
}) {
  return (
    <ReactFlowProvider>
      <CanvasInner
        selectedNodeId={selectedNodeId}
        onSelectNode={onSelectNode}
        renameEvent={renameEvent}
        onRenameConsumed={onRenameConsumed}
        reloadKey={reloadKey}
        onCanvasNodeDelete={onCanvasNodeDelete}
      />
    </ReactFlowProvider>
  );
}

function CanvasInner({
  selectedNodeId,
  onSelectNode,
  renameEvent,
  onRenameConsumed,
  reloadKey,
  onCanvasNodeDelete,
}: {
  selectedNodeId: string | null;
  onSelectNode: (node: BlueprintNode | null) => void;
  renameEvent?: RenameEvent | null;
  onRenameConsumed?: () => void;
  reloadKey?: number;
  onCanvasNodeDelete?: (node: BlueprintNode) => Promise<void>;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<BlueprintNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [nextNameByType, setNextNameByType] = useState<Record<string, number>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const { screenToFlowPosition } = useReactFlow();

  // Load existing resources from disk on mount and whenever the parent
  // bumps `reloadKey` (e.g., after a successful Save / Delete or after
  // the chat agent's Edit/Write tool fires). The canvas reconciles
  // server state with any client-only nodes the user dropped but
  // hasn't saved yet — those keep their position; saved nodes get
  // updated attributes + positions; newly-appeared nodes (typically
  // AI-written) flash an amber ring.
  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    let clearArrivalTimer: ReturnType<typeof setTimeout> | null = null;

    fetchBlueprintResources(ac.signal)
      .then((res) => {
        if (cancelled) return;
        setLoadError(null);
        const newEdges = buildEdges(res.edges);
        let newArrivalIds: string[] = [];
        // Drives the post-setState side effect: when auto-layout
        // fires we persist the computed positions to `_layout.json`
        // so subsequent reloads don't re-run dagre and shift the
        // user's mental map.
        let layoutToPersist: Record<string, { x: number; y: number }> | null = null;

        setNodes((prev) => {
          const reconciled = reconcileNodes(prev, res.resources);
          newArrivalIds = reconciled.newArrivals;
          if (shouldAutoLayout(reconciled.newArrivals, reconciled.nodes)) {
            const laidOut = autoLayoutNodes(reconciled.nodes, newEdges);
            // Only persist for nodes that exist on disk (server-id format).
            // Un-saved drops don't have a layout key yet.
            const positions: Record<string, { x: number; y: number }> = {};
            for (const n of laidOut) {
              const expectedId = `${n.data.resourceType}.${n.data.name}`;
              if (n.id === expectedId) {
                positions[expectedId] = n.position;
              }
            }
            if (Object.keys(positions).length > 0) {
              layoutToPersist = positions;
            }
            return laidOut;
          }
          return reconciled.nodes;
        });
        setEdges(newEdges);

        if (layoutToPersist) {
          void patchBlueprintLayout(layoutToPersist).catch(() => {
            // Layout persistence is best-effort. If it fails (offline,
            // permissions, etc.), the canvas state is still correct;
            // the next reload will just re-run auto-layout.
          });
        }

        // Clear the `justArrived` flag after ~2.5s so the pulse stops
        // on its own. If the user reloads again before the timer fires,
        // the next reconcile resets the flag anyway.
        if (newArrivalIds.length > 0) {
          clearArrivalTimer = setTimeout(() => {
            setNodes((nds) =>
              nds.map((n) =>
                newArrivalIds.includes(n.id)
                  ? { ...n, data: { ...n.data, justArrived: false } }
                  : n,
              ),
            );
          }, 2500);
        }
      })
      .catch((e: Error) => {
        if (cancelled || e.name === "AbortError") return;
        setLoadError(e.message);
      });

    return () => {
      cancelled = true;
      ac.abort();
      if (clearArrivalTimer !== null) clearTimeout(clearArrivalTimer);
    };
  }, [reloadKey, setNodes, setEdges]);

  const nodeTypes = useMemo(
    () => ({
      resource: ResourceNode,
    }),
    [],
  );

  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      const resourceType = e.dataTransfer.getData(PALETTE_DRAG_TYPE);
      if (!resourceType) return;
      const meta = familyOf(resourceType);
      const position = screenToFlowPosition({
        x: e.clientX,
        y: e.clientY,
      });
      // Default name: "<type-leaf>_<n>". Increment counter per type so
      // a second drop of the same type doesn't collide with the first.
      const leaf = resourceType.replace(/^aws_/, "");
      const n = (nextNameByType[resourceType] ?? 0) + 1;
      setNextNameByType((prev) => ({ ...prev, [resourceType]: n }));
      const newNode: BlueprintNode = {
        id: `${resourceType}.${leaf}_${n}_${Date.now().toString(36)}`,
        type: "resource",
        position,
        data: {
          resourceType,
          name: `${leaf}_${n}`,
          family: meta.family,
          monogram: meta.monogram,
        },
      };
      setNodes((nds) => [...nds, newNode]);
      onSelectNode(newNode);
    },
    [screenToFlowPosition, setNodes, nextNameByType, onSelectNode],
  );

  // Bubble selection up to the parent so the drawer can react.
  const onNodeClick = useCallback(
    (_: unknown, node: BlueprintNode) => onSelectNode(node),
    [onSelectNode],
  );
  const onPaneClick = useCallback(() => onSelectNode(null), [onSelectNode]);

  // Intercept React Flow's built-in delete gesture (Backspace / Delete
  // key when a node is selected) so we hit the backend before the node
  // disappears from the canvas. Returning false from this prop cancels
  // both the visual removal and React Flow's internal state update; if
  // the backend delete fails we want the node to stay visible so the
  // user can see and act on the failure. Edges aren't independently
  // deletable — they're derived from HCL refs, so deleting one would
  // just bring it back on next reload. We swallow edge-only deletes.
  const onBeforeDelete = useCallback(
    async (params: { nodes: Node[]; edges: Edge[] }) => {
      const nodesToDelete = params.nodes as BlueprintNode[];
      if (nodesToDelete.length === 0) return false;
      if (!onCanvasNodeDelete) return true;
      try {
        for (const n of nodesToDelete) {
          await onCanvasNodeDelete(n);
        }
        return true;
      } catch (e) {
        setLoadError(`Delete failed: ${(e as Error).message}`);
        return false;
      }
    },
    [onCanvasNodeDelete],
  );

  // React to rename events from the drawer's Save handler. We update
  // the matching node's `data.name` in place, then ack so the parent
  // can clear its rename slot. The lint rule fires on the setState-in-
  // effect; this is the "consume external event" pattern.
  useEffect(() => {
    if (!renameEvent) return;
    setNodes((nds) =>
      nds.map((n) =>
        n.id === renameEvent.nodeId
          ? { ...n, data: { ...n.data, name: renameEvent.newName } }
          : n,
      ),
    );
    onRenameConsumed?.();
  }, [renameEvent, setNodes, onRenameConsumed]);

  // Drag-to-save: when React Flow finishes a node drag, the change
  // batch includes a position change with `dragging: false`. We pluck
  // those out, debounce 400ms (so a long drag is one PATCH), and
  // ship the new positions to `_layout.json` via the layout endpoint.
  // The HCL file is untouched — only the sidecar moves.
  const pendingPositionsRef = useRef<Record<string, { x: number; y: number }>>({});
  const positionFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushPendingPositions = useCallback(() => {
    const positions = pendingPositionsRef.current;
    pendingPositionsRef.current = {};
    positionFlushTimerRef.current = null;
    if (Object.keys(positions).length === 0) return;
    void patchBlueprintLayout(positions).catch(() => {
      // Best-effort: a failed PATCH just means the position will be
      // recomputed on next reload (or re-saved on the next drag).
    });
  }, []);

  const handleNodesChange = useCallback(
    (changes: NodeChange<BlueprintNode>[]) => {
      // Always let React Flow's internal state update — that's the
      // visual feedback during the drag.
      onNodesChange(changes);
      // Collect post-drag positions for nodes that actually exist on
      // disk (server-id format `<type>.<name>`). Un-saved drops don't
      // have a layout entry to update.
      for (const ch of changes) {
        if (ch.type !== "position") continue;
        if (ch.dragging) continue; // still mid-drag; wait for the end
        if (!ch.position) continue;
        const node = nodes.find((n) => n.id === ch.id);
        if (!node) continue;
        const expectedId = `${node.data.resourceType}.${node.data.name}`;
        if (node.id !== expectedId) continue;
        pendingPositionsRef.current[expectedId] = ch.position;
      }
      if (Object.keys(pendingPositionsRef.current).length === 0) return;
      if (positionFlushTimerRef.current !== null) {
        clearTimeout(positionFlushTimerRef.current);
      }
      positionFlushTimerRef.current = setTimeout(flushPendingPositions, 400);
    },
    [onNodesChange, nodes, flushPendingPositions],
  );

  // On unmount, fire any pending PATCH so a drag-then-tab-switch
  // doesn't drop the unsent move.
  useEffect(
    () => () => {
      if (positionFlushTimerRef.current !== null) {
        clearTimeout(positionFlushTimerRef.current);
        flushPendingPositions();
      }
    },
    [flushPendingPositions],
  );

  // Manual auto-layout — runs on demand when the user clicks the
  // "Layout" button. Persists the result to `_layout.json` so reloads
  // don't re-run dagre.
  const runManualLayout = useCallback(() => {
    if (nodes.length === 0) return;
    const laidOut = autoLayoutNodes(nodes, edges);
    setNodes(laidOut);
    const positions: Record<string, { x: number; y: number }> = {};
    for (const n of laidOut) {
      const expectedId = `${n.data.resourceType}.${n.data.name}`;
      if (n.id === expectedId) positions[expectedId] = n.position;
    }
    if (Object.keys(positions).length > 0) {
      void patchBlueprintLayout(positions).catch(() => {});
    }
  }, [nodes, edges, setNodes]);

  // Reflect external selection (e.g., parent clears) onto the canvas.
  const nodesWithSelection = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        selected: n.id === selectedNodeId,
      })),
    [nodes, selectedNodeId],
  );

  return (
    <div className="flex-1 min-h-0 flex">
      <Palette />
      <div ref={wrapperRef} className="flex-1 min-w-0 relative">
        <ReactFlow
          nodes={nodesWithSelection}
          edges={edges}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          onBeforeDelete={onBeforeDelete}
          nodeTypes={nodeTypes}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls position="bottom-right" />
          <Panel
            position="top-right"
            className="!m-2 flex items-center gap-1"
          >
            <button
              type="button"
              onClick={runManualLayout}
              disabled={nodes.length === 0}
              title="Auto-arrange nodes with Dagre (LR dependency layout)"
              className="px-1.5 h-6 text-[10px] font-mono rounded-sm border border-border bg-background hover:bg-muted text-foreground transition-colors disabled:opacity-50"
            >
              auto-layout
            </button>
          </Panel>
        </ReactFlow>
        {loadError && (
          <div className="absolute top-3 left-3 right-3 text-[11px] font-mono rounded-sm border border-red-200 dark:border-red-900 px-3 py-2 text-red-600 dark:text-red-400 bg-background/95 whitespace-pre-wrap">
            {loadError}
          </div>
        )}
        {nodes.length === 0 && !loadError && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <p className="text-xs text-muted-foreground">
              Drag a resource from the palette onto the canvas.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Merge server-side resources with whatever the user has already on
 * the canvas:
 *
 *   - Nodes that exist on disk (matched by `<type>.<name>`) get their
 *     attributes + position refreshed from the server. Their canvas id
 *     stays stable so selection/highlight state doesn't flicker.
 *   - Nodes that the user dropped but hasn't saved yet (no server
 *     match) are preserved as-is — losing un-saved work on every
 *     reload would feel awful.
 *   - Server-side resources the canvas doesn't have yet (e.g., the AI
 *     agent created one via Write) are added as fresh nodes with
 *     `data.justArrived = true` so the visual highlight fires.
 */
function reconcileNodes(
  existing: BlueprintNode[],
  server: BlueprintResource[],
): { nodes: BlueprintNode[]; newArrivals: string[] } {
  const serverByAddress = new Map(
    server.map((r) => [`${r.type}.${r.name}`, r]),
  );
  // Existing nodes that have a saved counterpart get a stable update.
  const merged: BlueprintNode[] = [];
  const consumed = new Set<string>();
  const newArrivals: string[] = [];

  for (const n of existing) {
    const addr = `${n.data.resourceType}.${n.data.name}`;
    const serverEntry = serverByAddress.get(addr);
    if (serverEntry) {
      consumed.add(addr);
      merged.push(serverNodeFrom(serverEntry, n.id));
    } else {
      // Treat unsaved nodes as those whose names don't yet exist on
      // disk. Keep them — un-saved drops shouldn't vanish on reload.
      merged.push(n);
    }
  }
  // Resources that exist on disk but the canvas didn't know about
  // (e.g., produced by the AI agent's Edit tool) get added fresh
  // and flagged so the node pulses an amber ring briefly.
  for (const r of server) {
    const addr = `${r.type}.${r.name}`;
    if (consumed.has(addr)) continue;
    const node = serverNodeFrom(r);
    node.data = { ...node.data, justArrived: true };
    merged.push(node);
    newArrivals.push(node.id);
  }
  return { nodes: merged, newArrivals };
}

function serverNodeFrom(
  r: BlueprintResource,
  existingId?: string,
): BlueprintNode {
  const meta = familyOf(r.type);
  return {
    id: existingId ?? `${r.type}.${r.name}`,
    type: "resource",
    position: r.position,
    data: {
      resourceType: r.type,
      name: r.name,
      family: meta.family,
      monogram: meta.monogram,
      attributes: r.attributes,
      blocks: r.blocks,
      parseError: r.parse_error,
      filename: r.filename,
    },
  };
}

function buildEdges(serverEdges: BlueprintEdge[]): Edge[] {
  // Source/target identify a node by `<type>.<name>` — the same
  // address `reconcileNodes` uses for the id when fabricating server-
  // origin nodes. Existing-user nodes have a different id format
  // (`<type>.<name>_<n>_<ts>`); they have no saved counterpart yet so
  // they have no edges anyway.
  return serverEdges.map((e) => ({
    id: `${e.source}->${e.target}`,
    source: e.source,
    target: e.target,
    type: "default",
    animated: false,
    markerEnd: { type: MarkerType.ArrowClosed },
  }));
}

function Palette() {
  return (
    <aside className="w-[180px] shrink-0 border-r border-border bg-muted/30 flex flex-col">
      <div className="px-3 h-8 border-b border-border flex items-center">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          palette
        </span>
      </div>
      <div className="p-2 flex flex-col gap-1.5 overflow-y-auto">
        {PALETTE.map((item) => (
          <PaletteTile key={item.type} item={item} />
        ))}
      </div>
      <div className="mt-auto px-3 py-2 text-[10px] text-muted-foreground border-t border-border">
        Drag onto the canvas. Selected node opens its form in the drawer.
      </div>
    </aside>
  );
}

function PaletteTile({ item }: { item: PaletteItem }) {
  const classes = FAMILY_CLASSES[item.family];
  const onDragStart = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.dataTransfer.setData(PALETTE_DRAG_TYPE, item.type);
      e.dataTransfer.effectAllowed = "move";
    },
    [item.type],
  );
  return (
    <div
      draggable
      onDragStart={onDragStart}
      className="flex items-center gap-2 px-2 py-1.5 rounded-sm border border-border bg-background hover:border-accent cursor-grab active:cursor-grabbing transition-colors"
      title={`Drag ${item.label} onto the canvas`}
    >
      <span
        className={`inline-flex items-center justify-center px-1.5 h-[20px] min-w-[28px] rounded-sm ring-1 ring-inset font-mono text-[11px] uppercase ${classes.chip}`}
      >
        {item.monogram}
      </span>
      <span className="text-xs text-foreground truncate">{item.label}</span>
    </div>
  );
}

function ResourceNode({ data, selected }: NodeProps<BlueprintNode>) {
  const meta = familyOf(data.resourceType);
  const classes = FAMILY_CLASSES[meta.family];
  // `justArrived` pulses an amber ring on nodes that just appeared via
  // a reload (typically: AI agent wrote HCL). Cleared by the canvas's
  // load-effect after ~2.5s. The selected ring takes precedence when
  // both are true so the user's active selection is never visually
  // dominated by the arrival pulse.
  const arrivalClasses =
    data.justArrived && !selected
      ? "ring-2 ring-amber-400 dark:ring-amber-500 animate-pulse"
      : "";
  return (
    <div
      className={`relative flex items-center gap-2 px-2 py-1.5 rounded-sm bg-background border ${
        selected
          ? "border-accent ring-1 ring-accent"
          : "border-border hover:border-accent"
      } ${arrivalClasses} shadow-sm transition-colors`}
    >
      {/* React Flow needs explicit `Handle` components on a custom
          node so edge endpoints can attach somewhere. Both source and
          target use the default handle id (null) so the auto-derived
          edges from /api/blueprint/resources line up — those edges
          don't carry sourceHandle/targetHandle ids either. Visually
          subdued: tiny circle inset behind the chip on the left and
          past the label on the right. */}
      <Handle
        type="target"
        position={Position.Left}
        className="!w-1.5 !h-1.5 !bg-border !border-0"
      />
      <span
        className={`inline-flex items-center justify-center px-1.5 h-[20px] min-w-[28px] rounded-sm ring-1 ring-inset font-mono text-[11px] uppercase ${classes.chip}`}
      >
        {meta.monogram}
      </span>
      <div className="min-w-0">
        <div className="font-mono text-xs text-foreground truncate max-w-[160px]">
          {data.name}
        </div>
        <div className="font-mono text-[10px] text-muted-foreground truncate max-w-[160px]">
          {data.resourceType}
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!w-1.5 !h-1.5 !bg-border !border-0"
      />
    </div>
  );
}
