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
  deleteBlueprintResource,
  fetchPlanDiff,
  setComponentOverride,
  type PlanRoot,
} from "@/lib/api";
import type {
  InventoryResource,
  PlanDiffResponse,
  Resource,
  ResourceChange,
} from "@/lib/types";

// The work surface (center) toggles between the blueprint canvas and the
// plan-diff. The resource tree is now a persistent navigator, not a tab.
type WorkTab = "canvas" | "plan";

// Prompt seeded into the chat by the Blueprint "commit to PR" button.
// The agent has the repo + Bash + the opentofu-* skills, so it can do
// the cleanup + git + PR itself. Kept terse but explicit about the
// non-negotiables: promote to a module, don't commit the bp.* sandbox
// files, don't apply, report the PR URL.
const BLUEPRINT_COMMIT_PROMPT = `Promote the current blueprint into a reviewable PR.

The Blueprint canvas authored resources as sandbox files at the root of
\`live/blueprint/\`, named \`bp.<type>.<name>.tf\`. Please:

1. Read every \`live/blueprint/bp.*.tf\` to understand the resources and
   their relationships (references between them are dependency edges).
2. Group the resources by their \`Component\` tag and extract each group
   into its own clean, reusable module under \`modules/<component>/\`
   (resources with no Component tag go in a sensibly-named module),
   following the opentofu-style-guide skill: proper file layout
   (versions.tf / variables.tf / main.tf / outputs.tf), typed +
   described variables for anything that should be caller-configurable,
   described outputs, and a day-one \`tests/plan.tftest.hcl\` per module.
3. Wire the module into an appropriate live root config with sensible
   inputs.
4. Run \`tofu fmt\` and \`tofu validate\` until clean.
5. Create a branch, commit (do NOT commit the \`bp.*.tf\` sandbox files
   or \`_layout.json\`), push, and open a PR with \`gh pr create --fill\`.
6. Report the PR URL back here.

Do not run \`tofu apply\`. Leave the blueprint sandbox files in place.`;

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

// Seeded by a component node's "+add" button. The agent authors new
// resources into the blueprint sandbox, tagged with the component so they
// classify under it in the tree.
function addToComponentPrompt(component: string): string {
  return `Add resources to the "${component}" component.

Author the new resource(s) into the blueprint sandbox at the root of
\`live/blueprint/\` as \`bp.<type>.<name>.tf\` files, following the repo
conventions. Tag every resource you add with \`Component = "${component}"\`
(merge into its \`tags\`) so it classifies under ${component} in the tree.
If it's unclear what to add, ask me first. Do not run \`tofu apply\`.`;
}

// Seeded by the pending-changes "commit to PR" button. The agent reads the
// owner's draft set and promotes each change into the right module per
// component, opening a PR. Apply stays manual.
function commitDraftsPrompt(): string {
  return `Promote my pending blueprint drafts into a reviewable PR.

My drafts live under \`live/blueprint/drafts/<owner>/\` — read its
\`_drafts.json\` (and the matching \`bp.<type>.<name>.tf\` files) for the
change set. Apply each draft by kind:
- "new": add the resource to its component's module (\`target_module\`),
  creating the module if needed, per the opentofu-style-guide skill.
- "edit": modify the existing resource (\`source_address\`) in its real module.
- "adopt": bring it under management via an \`import { }\` block.
- "delete": remove the resource from its module (a destroy).

Group by component, run \`tofu fmt\` + \`tofu validate\`, create a branch,
commit (do NOT commit the \`drafts/\` sandbox), push, open a PR with
\`gh pr create --fill\`, and report the URL. Do not run \`tofu apply\`.`;
}

export default function Home() {
  const [selected, setSelected] = useState<Resource | null>(null);
  // Full inventory row for the tree selection — drives the unified inspector
  // (state/draft/component). `selected` (Resource) stays for chat context.
  const [selectedItem, setSelectedItem] = useState<InventoryResource | null>(
    null,
  );
  // When set, region 4 shows the QuickCreate form for this component.
  const [creating, setCreating] = useState<{ component: string } | null>(null);
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
  // Set by the "commit to PR" button — the ChatPanel auto-sends this
  // as a user message, driving the agent to promote the blueprint.
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);

  // Seed the agent with a promote-to-PR prompt and reveal the chat.
  const handleCommitToPR = useCallback(() => {
    setPendingPrompt(BLUEPRINT_COMMIT_PROMPT);
  }, []);

  // Shared "delete a canvas node" handler — the canvas calls it from
  // React Flow's Backspace/Delete gesture; the drawer's Delete button
  // shares the same logic. Saved nodes hit the backend; un-saved drops
  // just clear from the canvas state. Promise resolves on success so
  // React Flow's `onBeforeDelete` can wait before removing the node
  // from canvas state.
  const handleBlueprintDelete = useCallback(
    async (node: BlueprintNode) => {
      const hasFile =
        node.data.attributes !== undefined ||
        node.id === `${node.data.resourceType}.${node.data.name}`;
      if (hasFile) {
        await deleteBlueprintResource(node.data.resourceType, node.data.name);
      }
      setBlueprintNode((prev) => (prev && prev.id === node.id ? null : prev));
      setBlueprintReload((k) => k + 1);
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
  const planAbortRef = useRef<AbortController | null>(null);

  const runPlan = useCallback(async () => {
    planAbortRef.current?.abort();
    const ac = new AbortController();
    planAbortRef.current = ac;
    setPlanLoading(true);
    setPlanError(null);
    try {
      setPlanDiff(await fetchPlanDiff(ac.signal, planRoot));
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setPlanError((e as Error).message);
    } finally {
      if (planAbortRef.current === ac) {
        setPlanLoading(false);
        planAbortRef.current = null;
      }
    }
  }, [planRoot]);

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
          onCommit={() => setPendingPrompt(commitDraftsPrompt())}
        />
        <ResourceTree
          selected={selected}
          onSelect={(item) => {
            setSelectedItem(item);
            setSelected(inventoryToResource(item));
            setBlueprintNode(null);
            setCreating(null);
          }}
          onAddToComponent={(c) => setCreating({ component: c })}
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
            onCommitToPR={handleCommitToPR}
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
            onRootChange={setPlanRoot}
          />
        )}
      </section>

      {/* Region 4 — Inspector */}
      <aside className="w-[380px] shrink-0 border-l border-border flex flex-col min-h-0">
        {creating ? (
          <QuickCreate
            component={creating.component}
            onCreated={(c) => {
              setCreating(null);
              setRefreshKey((k) => k + 1);
              // Show the just-created draft in the inspector immediately
              // (a minimal row; the tree refresh fills in the parsed one).
              const item: InventoryResource = {
                address: `${c.type}.${c.name}`,
                type: c.type,
                name: c.name,
                id: null,
                arn: null,
                account: "unknown",
                region: "unknown",
                managed: false,
                state: "planned",
                component: c.component,
                component_source: "tag",
                draft_kind: "new",
                tags: { Component: c.component },
                values: {},
              };
              setSelectedItem(item);
              setSelected(inventoryToResource(item));
              setBlueprintNode(null);
            }}
            onCancel={() => setCreating(null)}
            onAskAgent={(c) => {
              setPendingPrompt(addToComponentPrompt(c));
              setCreating(null);
            }}
          />
        ) : blueprintNode ? (
          <BlueprintNodeDrawer
            node={blueprintNode}
            onClose={() => setBlueprintNode(null)}
            onRename={(nodeId, newName) => {
              setBlueprintRename({ nodeId, newName });
              setBlueprintNode((prev) =>
                prev && prev.id === nodeId
                  ? { ...prev, data: { ...prev.data, name: newName } }
                  : prev,
              );
            }}
            onResourceWritten={() => setBlueprintReload((k) => k + 1)}
            onResourceDeleted={(nodeId) => {
              setBlueprintNode((prev) =>
                prev && prev.id === nodeId ? null : prev,
              );
              setBlueprintReload((k) => k + 1);
            }}
            onNavigateToRef={setBlueprintPanTo}
          />
        ) : selectedItem ? (
          <ResourceInspector
            item={selectedItem}
            change={selectedChange}
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
