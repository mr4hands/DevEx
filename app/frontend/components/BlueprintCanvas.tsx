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

import {
  fetchBlueprintResources,
  writeDraft,
} from "@/lib/api";
import {
  autoLayoutNodes,
} from "@/lib/blueprintLayout";
import {
  FAMILY_CLASSES,
  familyOf,
} from "@/lib/resourceFamilies";
import {
  EXISTING_DRAG_TYPE,
  PALETTE,
  PALETTE_DRAG_TYPE,
  type PaletteItem,
} from "@/lib/blueprintPalette";
import type {
  BlueprintBlockInstance,
  BlueprintEdge,
  BlueprintResource,
  ExistingResource,
  LeafCoords,
} from "@/lib/types";

/**
 * The Blueprint canvas — drag resource tiles from the palette onto the
 * grid to plan an OpenTofu workspace visually.
 *
 * Phase 2b: the canvas is leaf-aware. Every node carries its overlay leaf
 * path; drops require an active leaf and write drafts immediately (adopt-
 * drop) or on Save (palette-drop). Layout is always auto-applied from the
 * server response (no persisted _layout.json). The promote button calls
 * the deterministic promote endpoint.
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
  /** Real cloud id when this node was adopted via an import block. */
  importId?: string | null;
  /** True when this node represents an adopted (imported) resource. */
  imported?: boolean;
  /** account/region/layer/component relpath this node was saved into.
   *  Absent for un-saved drops (they use the active leaf on save). */
  leaf?: string;
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
  panToAddress,
  onPanConsumed,
  activeLeaf,
  onPromote,
  onAdopted,
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
  /** When set, the canvas pans + zooms onto the node whose
   *  `<type>.<name>` address matches. Used by the drawer's reference
   *  eye-icon — clicking it sets the address, the canvas finds the
   *  matching node, centers on it, then acks via `onPanConsumed` so
   *  the address can clear and not re-pan on every render. */
  panToAddress?: string | null;
  onPanConsumed?: () => void;
  /** The active authoring leaf — drops require this to be set. */
  activeLeaf: LeafCoords | null;
  /** Fired by the "promote to PR" button. */
  onPromote?: () => void;
  /** Called after an adopt-drop (drag from the unified tree) persists the
   *  import file, so the parent can refresh the canvas + the tree. */
  onAdopted?: () => void;
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
        panToAddress={panToAddress}
        onPanConsumed={onPanConsumed}
        activeLeaf={activeLeaf}
        onPromote={onPromote}
        onAdopted={onAdopted}
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
  panToAddress,
  onPanConsumed,
  activeLeaf,
  onPromote,
  onAdopted,
}: {
  selectedNodeId: string | null;
  onSelectNode: (node: BlueprintNode | null) => void;
  renameEvent?: RenameEvent | null;
  onRenameConsumed?: () => void;
  reloadKey?: number;
  onCanvasNodeDelete?: (node: BlueprintNode) => Promise<void>;
  panToAddress?: string | null;
  onPanConsumed?: () => void;
  activeLeaf: LeafCoords | null;
  onPromote?: () => void;
  onAdopted?: () => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<BlueprintNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [nextNameByType, setNextNameByType] = useState<Record<string, number>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const { screenToFlowPosition, setCenter } = useReactFlow();

  // Load existing resources from disk on mount and whenever the parent
  // bumps `reloadKey` (e.g., after a successful Save / Delete or after
  // the chat agent's Edit/Write tool fires). The canvas reconciles
  // server state with any client-only nodes the user dropped but
  // hasn't saved yet — those keep their position; saved nodes get
  // updated attributes; newly-appeared nodes (typically AI-written)
  // flash an amber ring.
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

        setNodes((prev) => {
          const reconciled = reconcileNodes(prev, res.resources);
          newArrivalIds = reconciled.newArrivals;
          // Overlay has no persisted positions; auto-layout keeps the graph
          // readable. Un-saved client drops keep their dropped position via
          // reconcileNodes (they aren't in `res.resources`).
          return autoLayoutNodes(reconciled.nodes, newEdges);
        });
        setEdges(newEdges);

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
    // The drop is only permitted when dropEffect is compatible with the
    // drag's effectAllowed. Existing-resource rows set effectAllowed
    // "copy" (adoption copies the resource into the blueprint, it
    // doesn't remove it from AWS), so we must echo "copy" for them —
    // otherwise the browser rejects the drop and onDrop never fires.
    // Palette tiles use "move".
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(
      EXISTING_DRAG_TYPE,
    )
      ? "copy"
      : "move";
  }, []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      if (!activeLeaf) {
        setLoadError("Select or create a leaf first (tree → + leaf).");
        return;
      }

      // Adopt-drop: a discovered resource dragged from the tree.
      const existingRaw = e.dataTransfer.getData(EXISTING_DRAG_TYPE);
      if (existingRaw) {
        let existing: ExistingResource;
        try {
          existing = JSON.parse(existingRaw) as ExistingResource;
        } catch {
          return;
        }
        const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        const adoptMeta = familyOf(existing.type);
        const leafRel = `${activeLeaf.account}/${activeLeaf.region}/${activeLeaf.layer}/${activeLeaf.component}`;
        const adoptedNode: BlueprintNode = {
          id: `${existing.type}.${existing.name}`,
          type: "resource",
          position,
          data: {
            resourceType: existing.type,
            name: existing.name,
            family: adoptMeta.family,
            monogram: adoptMeta.monogram,
            attributes: existing.summary_attributes,
            importId: existing.import_id,
            imported: true,
            leaf: leafRel,
          },
        };
        setNodes((nds) => [
          ...nds.filter((n) => n.id !== adoptedNode.id),
          adoptedNode,
        ]);
        onSelectNode(adoptedNode);
        void writeDraft({
          kind: "adopt",
          type: existing.type,
          name: existing.name,
          import_id: existing.import_id,
          attributes: existing.summary_attributes,
          ...activeLeaf,
        })
          .then(() => onAdopted?.())
          .catch((err: Error) =>
            setLoadError(`Adopt failed: ${err.message}`),
          );
        return;
      }

      // Palette-drop: a fresh resource. Persisted when the user saves the
      // drawer form; we just place a client-only node tagged with the leaf.
      const resourceType = e.dataTransfer.getData(PALETTE_DRAG_TYPE);
      if (!resourceType) return;
      const meta = familyOf(resourceType);
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const leaf = resourceType.replace(/^aws_/, "");
      const n = (nextNameByType[resourceType] ?? 0) + 1;
      setNextNameByType((prev) => ({ ...prev, [resourceType]: n }));
      const leafRel = `${activeLeaf.account}/${activeLeaf.region}/${activeLeaf.layer}/${activeLeaf.component}`;
      const newNode: BlueprintNode = {
        id: `${resourceType}.${leaf}_${n}_${Date.now().toString(36)}`,
        type: "resource",
        position,
        data: {
          resourceType,
          name: `${leaf}_${n}`,
          family: meta.family,
          monogram: meta.monogram,
          leaf: leafRel,
        },
      };
      setNodes((nds) => [...nds, newNode]);
      onSelectNode(newNode);
    },
    [activeLeaf, screenToFlowPosition, setNodes, nextNameByType, onSelectNode, onAdopted],
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

  // Pan-and-zoom onto a node by `<type>.<name>` address. Triggered by
  // the drawer's reference eye-icon — clicking it on a `vpc_id` field
  // jumps the canvas to the VPC node and selects it. Centers using
  // React Flow's `setCenter` with a slight zoom-in so the target
  // stands out from neighbors; selection updates flow via the
  // parent's `onSelectNode` so the drawer swaps to the new context.
  useEffect(() => {
    if (!panToAddress) return;
    const target = nodes.find(
      (n) => `${n.data.resourceType}.${n.data.name}` === panToAddress,
    );
    if (target) {
      // Center on the node's middle. The 220×56 card sizing matches
      // `autoLayoutNodes` so the offsets line up.
      setCenter(target.position.x + 110, target.position.y + 28, {
        zoom: 1.1,
        duration: 350,
      });
      onSelectNode(target);
    }
    onPanConsumed?.();
  }, [panToAddress, nodes, setCenter, onSelectNode, onPanConsumed]);

  // Manual auto-layout — runs on demand when the user clicks the
  // "Layout" button.
  const runManualLayout = useCallback(() => {
    if (nodes.length === 0) return;
    setNodes(autoLayoutNodes(nodes, edges));
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
          onNodesChange={onNodesChange}
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
            position="top-left"
            className="!m-2"
          >
            <span className="px-1.5 h-6 inline-flex items-center text-[10px] font-mono rounded-sm border border-border bg-background/95 text-muted-foreground">
              {activeLeaf
                ? `leaf: ${activeLeaf.layer}/${activeLeaf.component}`
                : "no leaf selected"}
            </span>
          </Panel>
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
            <button
              type="button"
              onClick={() => onPromote?.()}
              disabled={nodes.length === 0 || !onPromote}
              title="Promote staged leaves into a PR (deterministic — no agent)"
              className="px-1.5 h-6 text-[10px] font-mono rounded-sm border border-accent bg-accent text-white hover:opacity-90 transition-colors disabled:opacity-50"
            >
              promote to PR
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
 *     attributes refreshed from the server. Their canvas id stays stable
 *     so selection/highlight state doesn't flicker.
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
    position: r.position ?? { x: 0, y: 0 },
    data: {
      resourceType: r.type,
      name: r.name,
      family: meta.family,
      monogram: meta.monogram,
      attributes: r.attributes,
      blocks: r.blocks,
      parseError: r.parse_error,
      filename: r.filename,
      importId: r.import_id ?? null,
      imported: Boolean(r.import_id),
      leaf: r.leaf,
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
      {(data.imported || data.importId) && (
        <span
          title={`adopted via import (id: ${data.importId ?? "?"})`}
          className="ml-1 inline-flex items-center px-1 h-[15px] rounded-sm ring-1 ring-inset ring-sky-400/50 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 font-mono text-[8px] uppercase tracking-wide"
        >
          imp
        </span>
      )}
      <Handle
        type="source"
        position={Position.Right}
        className="!w-1.5 !h-1.5 !bg-border !border-0"
      />
    </div>
  );
}
