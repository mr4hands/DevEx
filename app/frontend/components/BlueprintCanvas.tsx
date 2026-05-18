"use client";

import {
  Background,
  Controls,
  MarkerType,
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

import { fetchBlueprintResources } from "@/lib/api";
import {
  FAMILY_CLASSES,
  familyOf,
} from "@/lib/resourceFamilies";
import {
  PALETTE,
  PALETTE_DRAG_TYPE,
  type PaletteItem,
} from "@/lib/blueprintPalette";
import type { BlueprintResource, BlueprintEdge } from "@/lib/types";

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
} & Record<string, unknown>;  // index signature satisfies React Flow's Node constraint

export type BlueprintNode = Node<BlueprintNodeData>;

export type RenameEvent = { nodeId: string; newName: string };

export function BlueprintCanvas({
  selectedNodeId,
  onSelectNode,
  renameEvent,
  onRenameConsumed,
  reloadKey,
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
}) {
  return (
    <ReactFlowProvider>
      <CanvasInner
        selectedNodeId={selectedNodeId}
        onSelectNode={onSelectNode}
        renameEvent={renameEvent}
        onRenameConsumed={onRenameConsumed}
        reloadKey={reloadKey}
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
}: {
  selectedNodeId: string | null;
  onSelectNode: (node: BlueprintNode | null) => void;
  renameEvent?: RenameEvent | null;
  onRenameConsumed?: () => void;
  reloadKey?: number;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<BlueprintNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [nextNameByType, setNextNameByType] = useState<Record<string, number>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const { screenToFlowPosition } = useReactFlow();

  // Load existing resources from disk on mount and whenever the parent
  // bumps `reloadKey` (e.g., after a successful Save / Delete). The
  // canvas reconciles server state with any client-only nodes the user
  // dropped but hasn't saved yet — those keep their position; saved
  // nodes get updated attributes + positions.
  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    fetchBlueprintResources(ac.signal)
      .then((res) => {
        if (cancelled) return;
        setLoadError(null);
        setNodes((prev) =>
          reconcileNodes(prev, res.resources),
        );
        setEdges(buildEdges(res.edges));
      })
      .catch((e: Error) => {
        if (cancelled || e.name === "AbortError") return;
        setLoadError(e.message);
      });
    return () => {
      cancelled = true;
      ac.abort();
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
          nodeTypes={nodeTypes}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls position="bottom-right" />
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
 *     agent created one via Write) are added as fresh nodes.
 */
function reconcileNodes(
  existing: BlueprintNode[],
  server: BlueprintResource[],
): BlueprintNode[] {
  const serverByAddress = new Map(
    server.map((r) => [`${r.type}.${r.name}`, r]),
  );
  // Existing nodes that have a saved counterpart get a stable update.
  const merged: BlueprintNode[] = [];
  const consumed = new Set<string>();

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
  // (e.g., produced by the AI agent's Edit tool) get added fresh.
  for (const r of server) {
    const addr = `${r.type}.${r.name}`;
    if (consumed.has(addr)) continue;
    merged.push(serverNodeFrom(r));
  }
  return merged;
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
  return (
    <div
      className={`flex items-center gap-2 px-2 py-1.5 rounded-sm bg-background border ${
        selected
          ? "border-accent ring-1 ring-accent"
          : "border-border hover:border-accent"
      } shadow-sm transition-colors`}
    >
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
    </div>
  );
}
