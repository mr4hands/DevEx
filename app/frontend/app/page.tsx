"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BlueprintCanvas, type BlueprintNode } from "@/components/BlueprintCanvas";
import { BlueprintNodeDrawer } from "@/components/BlueprintNodeDrawer";
import { ChatPanel } from "@/components/ChatPanel";
import { PendingChanges } from "@/components/PendingChanges";
import { PlanDiff } from "@/components/PlanDiff";
import { QuickCreate } from "@/components/QuickCreate";
import { ResourceDrawer } from "@/components/ResourceDrawer";
import { ResourceInspector } from "@/components/ResourceInspector";
import { ResourceTree, inventoryToResource } from "@/components/ResourceTree";
import {
  discardDraft,
  fetchBlueprintResources,
  fetchPlanDiff,
  promoteDrafts,
  setComponentOverride,
  type PlanRoot,
} from "@/lib/api";
import type {
  InventoryResource,
  LeafCoords,
  PlanDiffResponse,
  Resource,
  ResourceChange,
} from "@/lib/types";
import { LeafForm } from "@/components/LeafForm";

// The work surface (center) toggles between the blueprint canvas and the
// plan-diff. The resource tree is now a persistent navigator, not a tab.
type WorkTab = "canvas" | "plan";

// Seeded into the chat by the Existing-resources tree's "discover" button.
// The agent has the read-only AWS MCP + the aws-resource-discovery skill,
// so it can enumerate the scope and write the manifest the tree reads.
function discoveryPrompt(scope: string): string {
  const target =
    scope === "all"
      ? "all supported AWS resource types"
      : `the type \`${scope}\``;
  return `Discover existing AWS resources for the Blueprint tree.

Use the aws-resource-discovery skill to enumerate ${target} via the
read-only AWS API MCP, then write/merge the results into
\`live/blueprint/_discovered.json\` in the manifest schema the skill
documents (groups of { address, type, name, import_id, summary_attributes }).
Do not modify any other files. Report how many resources you found.`;
}

// "a/r/l/c" -> LeafCoords. Returns null if the relpath isn't 4 segments.
function leafToCoords(leaf: string): LeafCoords | null {
  const [account, region, layer, component] = leaf.split("/");
  if (!account || !region || !layer || !component) return null;
  return { account, region, layer, component };
}

export default function Home() {
  const [selected, setSelected] = useState<Resource | null>(null);
  // Full inventory row for the tree selection — drives the unified inspector
  // (state/draft/component). `selected` (Resource) stays for chat context.
  const [selectedItem, setSelectedItem] = useState<InventoryResource | null>(
    null,
  );
  // The leaf every author surface (canvas drop, adopt, quick-create) targets.
  const [activeLeaf, setActiveLeaf] = useState<LeafCoords | null>(null);
  // When set, region 4 shows QuickCreate for these coords.
  const [creating, setCreating] = useState<LeafCoords | null>(null);
  // When true, region 4 shows the LeafForm.
  const [creatingLeaf, setCreatingLeaf] = useState(false);
  // Last promote result (PR URL) surfaced by the pending bar.
  const [promoteResult, setPromoteResult] = useState<
    { url: string } | { error: string } | null
  >(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [workTab, setWorkTab] = useState<WorkTab>("canvas");
  // The agent column collapses to a thin strip to give the work surface room.
  const [agentCollapsed, setAgentCollapsed] = useState(false);
  // Blueprint state lives separately from `selected` because a blueprint
  // node represents a *planned* resource (no AWS state) and has its own
  // attribute form; conflating them would force ResourceDrawer to handle
  // both shapes.
  const [blueprintNode, setBlueprintNode] = useState<BlueprintNode | null>(null);
  // Rename events bubble up from the drawer's Save handler so the
  // canvas can update the node label without a full re-render dance.
  // Stored as `{ nodeId, newName }`; the canvas hook consumes it.
  const [blueprintRename, setBlueprintRename] = useState<
    { nodeId: string; newName: string } | null
  >(null);
  // Bumped after every successful Save or Delete in the drawer so the
  // canvas refetches the server-side resources + edges. Phase 3's
  // round-trip flows through this signal.
  const [blueprintReload, setBlueprintReload] = useState(0);
  // Target for the drawer's reference eye-icon: when the user clicks
  // the eye next to `vpc_id = aws_vpc.main.id`, we set this to
  // `aws_vpc.main` and the canvas pans + selects the matching node.
  const [blueprintPanTo, setBlueprintPanTo] = useState<string | null>(null);
  // Set by the tree's "discover" button — the ChatPanel auto-sends this as a
  // user message, driving the agent to enumerate unmanaged AWS resources.
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);

  const handlePromote = useCallback(async () => {
    setPromoteResult(null);
    try {
      const res = await promoteDrafts();
      setPromoteResult({ url: res.pr_url });
      setRefreshKey((k) => k + 1);
      setBlueprintReload((k) => k + 1);
    } catch (e) {
      setPromoteResult({ error: (e as Error).message });
    }
  }, []);

  // Shared "delete a canvas node" handler — the canvas calls it from
  // React Flow's Backspace/Delete gesture; the drawer's Delete button
  // shares the same logic. A canvas node now belongs to a leaf, so
  // delete = discard the draft.
  const handleBlueprintDelete = useCallback(
    async (node: BlueprintNode) => {
      const coords = node.data.leaf ? leafToCoords(node.data.leaf) : null;
      // Only saved nodes (server-id format) have a leaf to discard from.
      if (coords) {
        await discardDraft(node.data.resourceType, node.data.name, coords);
      }
      setBlueprintNode((prev) => (prev && prev.id === node.id ? null : prev));
      setBlueprintReload((k) => k + 1);
      setRefreshKey((k) => k + 1);
    },
    [],
  );

  // Hoisted plan-diff state — shared across PlanDiff and ResourceDrawer
  // (in-plan strip + change).
  const [planDiff, setPlanDiff] = useState<PlanDiffResponse | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  // When the user clicks "open in PlanDiff" from the drawer, we route
  // them to the Plan tab + expand that row.
  const [planFocusAddress, setPlanFocusAddress] = useState<string | null>(null);
  // Which workspace the Plan tab is currently looking at. Flipping to
  // "blueprint" surfaces the canvas's `live/blueprint/` workspace.
  const [planRoot, setPlanRoot] = useState<PlanRoot>("default");
  const [planLeaf, setPlanLeaf] = useState<string | null>(null);
  const [stagedLeaves, setStagedLeaves] = useState<string[]>([]);
  const planAbortRef = useRef<AbortController | null>(null);

  const runPlan = useCallback(async () => {
    planAbortRef.current?.abort();
    const ac = new AbortController();
    planAbortRef.current = ac;
    setPlanLoading(true);
    setPlanError(null);
    try {
      setPlanDiff(await fetchPlanDiff(ac.signal, planRoot, planLeaf ?? undefined));
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setPlanError((e as Error).message);
    } finally {
      if (planAbortRef.current === ac) {
        setPlanLoading(false);
        planAbortRef.current = null;
      }
    }
  }, [planRoot, planLeaf]);

  // Run an initial plan on mount + whenever the workspace selector
  // changes, so flipping to "blueprint" actually fetches a blueprint
  // plan rather than waiting for the user to hit "run plan".
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void runPlan();
    return () => planAbortRef.current?.abort();
  }, [runPlan]);

  const onToolResult = useCallback(() => {
    // Refresh on every tool result — agent may have mutated state.
    //
    // - `refreshKey` re-fetches the unified resource tree (inventory).
    // - `blueprintReload` re-fetches the Blueprint canvas. The chat
    //   agent's `Edit`/`Write` tools land HCL in `live/blueprint/`;
    //   bumping this here is what makes AI-placed resources show up on
    //   the canvas without a manual refresh.
    // - Plan tab does NOT auto-refresh; `tofu plan` is slow and a
    //   single agent turn often runs many tools. User re-triggers
    //   explicitly via "run plan".
    setRefreshKey((k) => k + 1);
    setBlueprintReload((k) => k + 1);
  }, []);

  // Index plan-diff changes by address for cheap lookups.
  const changesByAddress = useMemo(() => {
    const m = new Map<string, ResourceChange>();
    if (planDiff) {
      for (const c of planDiff.changes) m.set(c.address, c);
    }
    return m;
  }, [planDiff]);

  const selectedChange = selected
    ? changesByAddress.get(selected.address) ?? null
    : null;

  const openInPlanDiff = useCallback((r: Resource) => {
    setPlanFocusAddress(r.address);
    setWorkTab("plan");
  }, []);

  // Persist a component override, then refresh the tree so the resource
  // moves to its new branch.
  const handleReassign = useCallback(
    async (address: string, component: string) => {
      await setComponentOverride(address, component);
      setRefreshKey((k) => k + 1);
    },
    [],
  );

  // Drop the planFocusAddress after a short delay so it doesn't keep
  // forcing the row open if the user later collapses it.
  useEffect(() => {
    if (!planFocusAddress) return;
    const t = window.setTimeout(() => setPlanFocusAddress(null), 1500);
    return () => window.clearTimeout(t);
  }, [planFocusAddress]);

  // Populate stagedLeaves from the overlay's unique leaf paths. Refreshes
  // on mount + after every blueprint reload (e.g., after a draft is saved).
  useEffect(() => {
    const ac = new AbortController();
    fetchBlueprintResources(ac.signal)
      .then((res) => {
        const uniq = Array.from(
          new Set(res.resources.map((r) => r.leaf).filter(Boolean) as string[]),
        ).sort();
        setStagedLeaves(uniq);
      })
      .catch((e: Error) => {
        // Don't clobber good data when the in-flight fetch is aborted by a
        // reload bump — the replacement fetch will repopulate.
        if (e.name === "AbortError") return;
        setStagedLeaves([]);
      });
    return () => ac.abort();
  }, [blueprintReload]);

  return (
    <main className="flex flex-1 min-h-0 h-screen">
      {/* Region 1 — Agent (collapsible) */}
      {agentCollapsed ? (
        <aside className="w-[40px] shrink-0 border-r border-border flex flex-col items-center pt-2">
          <button
            type="button"
            onClick={() => setAgentCollapsed(false)}
            title="Expand agent"
            className="h-7 w-7 inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted rounded-sm"
          >
            ›
          </button>
          <span className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground [writing-mode:vertical-rl]">
            agent
          </span>
        </aside>
      ) : (
        <aside className="w-[320px] shrink-0 border-r border-border flex flex-col min-h-0">
          <div className="flex items-center justify-between px-2 h-7 border-b border-border shrink-0">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground pl-1">
              agent
            </span>
            <button
              type="button"
              onClick={() => setAgentCollapsed(true)}
              title="Collapse agent"
              className="h-6 w-6 inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted rounded-sm"
            >
              ‹
            </button>
          </div>
          <ChatPanel
            onToolResult={onToolResult}
            contextResource={selected}
            onClearContext={() => setSelected(null)}
            pendingPrompt={pendingPrompt}
            onPendingConsumed={() => setPendingPrompt(null)}
          />
        </aside>
      )}

      {/* Region 2 — Resource tree (persistent navigator) */}
      <aside className="w-[260px] shrink-0 border-r border-border flex flex-col min-h-0">
        <PendingChanges
          refreshKey={refreshKey}
          onPromote={handlePromote}
          result={promoteResult}
          onDismissResult={() => setPromoteResult(null)}
        />
        <ResourceTree
          selected={selected}
          onSelect={(item) => {
            setSelectedItem(item);
            setSelected(inventoryToResource(item));
            setBlueprintNode(null);
            setCreating(null);
            setCreatingLeaf(false);
          }}
          onSelectLeaf={(coords) => setActiveLeaf(coords)}
          onAddToLeaf={(coords) => {
            setActiveLeaf(coords);
            setCreating(coords);
            setCreatingLeaf(false);
          }}
          onNewLeaf={() => {
            setCreatingLeaf(true);
            setCreating(null);
          }}
          onDiscover={(scope) => setPendingPrompt(discoveryPrompt(scope))}
          refreshKey={refreshKey}
        />
      </aside>

      {/* Region 3 — Work surface (canvas / plan diff) */}
      <section className="flex-1 min-w-0 flex flex-col min-h-0">
        <WorkTabBar value={workTab} onChange={setWorkTab} />
        {workTab === "canvas" && (
          <BlueprintCanvas
            selectedNodeId={blueprintNode?.id ?? null}
            onSelectNode={setBlueprintNode}
            renameEvent={blueprintRename}
            onRenameConsumed={() => setBlueprintRename(null)}
            reloadKey={blueprintReload}
            onCanvasNodeDelete={handleBlueprintDelete}
            panToAddress={blueprintPanTo}
            onPanConsumed={() => setBlueprintPanTo(null)}
            activeLeaf={activeLeaf}
            onPromote={handlePromote}
            onAdopted={() => {
              setBlueprintReload((k) => k + 1);
              setRefreshKey((k) => k + 1);
            }}
          />
        )}
        {workTab === "plan" && (
          <PlanDiff
            diff={planDiff}
            loading={planLoading}
            error={planError}
            onRunPlan={runPlan}
            focusAddress={planFocusAddress}
            root={planRoot}
            onRootChange={(r) => {
              setPlanRoot(r);
              if (r !== "blueprint") setPlanLeaf(null);
            }}
            leaf={planLeaf}
            onLeafChange={setPlanLeaf}
            leaves={stagedLeaves}
          />
        )}
      </section>

      {/* Region 4 — Inspector */}
      <aside className="w-[380px] shrink-0 border-l border-border flex flex-col min-h-0">
        {creatingLeaf ? (
          <LeafForm
            onCreate={(coords) => {
              setActiveLeaf(coords);
              setCreating(coords);
              setCreatingLeaf(false);
            }}
            onCancel={() => setCreatingLeaf(false)}
          />
        ) : creating ? (
          <QuickCreate
            coords={creating}
            onCreated={(c) => {
              setCreating(null);
              setRefreshKey((k) => k + 1);
              const item: InventoryResource = {
                address: `${c.type}.${c.name}`,
                type: c.type,
                name: c.name,
                id: null,
                arn: null,
                account: creating.account,
                region: creating.region,
                layer: creating.layer,
                managed: false,
                state: "planned",
                component: creating.component,
                component_source: "leaf",
                draft_kind: "new",
                tags: {},
                values: {},
              };
              setSelectedItem(item);
              setSelected(inventoryToResource(item));
              setBlueprintNode(null);
            }}
            onCancel={() => setCreating(null)}
          />
        ) : blueprintNode ? (
          <BlueprintNodeDrawer
            node={blueprintNode}
            activeLeaf={activeLeaf}
            onClose={() => setBlueprintNode(null)}
            onRename={(nodeId, newName) => {
              setBlueprintRename({ nodeId, newName });
              setBlueprintNode((prev) =>
                prev && prev.id === nodeId
                  ? { ...prev, data: { ...prev.data, name: newName } }
                  : prev,
              );
            }}
            onResourceWritten={() => {
              setBlueprintReload((k) => k + 1);
              setRefreshKey((k) => k + 1);
            }}
            onResourceDeleted={(nodeId) => {
              setBlueprintNode((prev) =>
                prev && prev.id === nodeId ? null : prev,
              );
              setBlueprintReload((k) => k + 1);
              setRefreshKey((k) => k + 1);
            }}
            onNavigateToRef={setBlueprintPanTo}
          />
        ) : selectedItem ? (
          <ResourceInspector
            item={selectedItem}
            change={selectedChange}
            activeLeaf={activeLeaf}
            onClose={() => {
              setSelected(null);
              setSelectedItem(null);
            }}
            onOpenInPlanDiff={openInPlanDiff}
            onReassign={handleReassign}
            onChanged={() => setRefreshKey((k) => k + 1)}
          />
        ) : (
          <ResourceDrawer resource={null} onClose={() => setSelected(null)} />
        )}
      </aside>
    </main>
  );
}

function WorkTabBar({
  value,
  onChange,
}: {
  value: WorkTab;
  onChange: (next: WorkTab) => void;
}) {
  return (
    <div className="flex items-center gap-1 px-3 h-8 border-b border-border bg-background shrink-0">
      <TabButton active={value === "canvas"} onClick={() => onChange("canvas")}>
        canvas
      </TabButton>
      <span className="text-border text-[10px]">|</span>
      <TabButton active={value === "plan"} onClick={() => onChange("plan")}>
        plan diff
      </TabButton>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-1.5 h-5 text-[10px] font-mono rounded-sm transition-colors hover:bg-muted ${
        active ? "text-foreground" : "text-muted-foreground"
      }`}
    >
      {children}
    </button>
  );
}
