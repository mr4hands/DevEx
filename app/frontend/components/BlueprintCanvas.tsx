"use client";

import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";

import {
  FAMILY_CLASSES,
  familyOf,
} from "@/lib/resourceFamilies";
import {
  PALETTE,
  PALETTE_DRAG_TYPE,
  type PaletteItem,
} from "@/lib/blueprintPalette";

/**
 * The Blueprint canvas — drag resource tiles from the palette onto the
 * grid to plan an OpenTofu workspace visually.
 *
 * Phase 1 scope (this PR):
 *   - Browser-only state. Nodes live in React state; nothing is
 *     written to HCL yet.
 *   - 5 supported resource types from the palette.
 *   - Click a node → fires `onSelectNode(node)` so the parent can
 *     swap the right-pane drawer to "edit blueprint node" mode.
 *
 * Phase 2+ will add:
 *   - Schema-driven attribute form in the drawer
 *   - Write to HCL via a new backend endpoint
 *   - HCL-derived edges (dependencies)
 *   - AI agent integration (the agent edits HCL, canvas re-reads)
 */
export type BlueprintNodeData = {
  resourceType: string;       // aws_s3_bucket
  name: string;               // user-set label, default "<type>_<n>"
  family: string;             // for the family color/monogram
  monogram: string;
} & Record<string, unknown>;  // index signature satisfies React Flow's Node constraint

export type BlueprintNode = Node<BlueprintNodeData>;

export function BlueprintCanvas({
  selectedNodeId,
  onSelectNode,
}: {
  selectedNodeId: string | null;
  onSelectNode: (node: BlueprintNode | null) => void;
}) {
  return (
    <ReactFlowProvider>
      <CanvasInner
        selectedNodeId={selectedNodeId}
        onSelectNode={onSelectNode}
      />
    </ReactFlowProvider>
  );
}

function CanvasInner({
  selectedNodeId,
  onSelectNode,
}: {
  selectedNodeId: string | null;
  onSelectNode: (node: BlueprintNode | null) => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<BlueprintNode>([]);
  const [nextNameByType, setNextNameByType] = useState<Record<string, number>>({});
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const { screenToFlowPosition } = useReactFlow();

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
          onNodesChange={onNodesChange}
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
        {nodes.length === 0 && (
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
