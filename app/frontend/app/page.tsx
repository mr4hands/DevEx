"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BlueprintCanvas, type BlueprintNode } from "@/components/BlueprintCanvas";
import { BlueprintNodeDrawer } from "@/components/BlueprintNodeDrawer";
import { ChatPanel } from "@/components/ChatPanel";
import { PlanDiff } from "@/components/PlanDiff";
import { ResourceDrawer } from "@/components/ResourceDrawer";
import { ResourceTree } from "@/components/ResourceTree";
import {
  deleteBlueprintResource,
  fetchPlanDiff,
  setComponentOverride,
  type PlanRoot,
} from "@/lib/api";
import type { PlanDiffResponse, Resource, ResourceChange } from "@/lib/types";

type MiddleTab = "list" | "plan" | "blueprint";

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
2. Extract them into a clean, reusable module under \`modules/<name>/\`,
   following the opentofu-style-guide skill: proper file layout
   (versions.tf / variables.tf / main.tf / outputs.tf), typed +
   described variables for anything that should be caller-configurable,
   described outputs, and a day-one \`tests/plan.tftest.hcl\`.
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

export default function Home() {
  const [selected, setSelected] = useState<Resource | null>(null);
  // Current component of the selected resource, surfaced by the tree so the
  // inspector can show + reassign it.
  const [selectedComponent, setSelectedComponent] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [middleTab, setMiddleTab] = useState<MiddleTab>("list");
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

  // Hoisted plan-diff state — shared across PlanDiff, ResourceList
  // (pending indicators), and ResourceDrawer (in-plan strip + change).
  const [planDiff, setPlanDiff] = useState<PlanDiffResponse | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  // When the user clicks "open in PlanDiff" from the drawer, we route
  // them to the Plan tab + expand that row.
  const [planFocusAddress, setPlanFocusAddress] = useState<string | null>(null);
  // Which workspace the Plan tab is currently looking at. The
  // ResourceList (pending indicators) follows whatever's set here so
  // the two views stay in sync; flipping to "blueprint" surfaces the
  // canvas's `live/blueprint/` workspace in both places.
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
    // - `refreshKey` re-fetches the ResourceList (live state).
    // - `blueprintReload` re-fetches the Blueprint canvas. The chat
    //   agent's `Edit`/`Write` tools can land HCL in
    //   `live/blueprint/resources/`; bumping this here is what makes
    //   AI-placed resources show up on the canvas without manual
    //   refresh — the whole point of the Blueprint AI integration.
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
    setMiddleTab("plan");
  }, []);

  // Persist a component override, then refresh the tree so the resource
  // moves to its new branch.
  const handleReassign = useCallback(
    async (address: string, component: string) => {
      await setComponentOverride(address, component);
      setSelectedComponent(component);
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
      <aside className="w-[360px] shrink-0 border-r border-border flex flex-col min-h-0">
        <ChatPanel
          onToolResult={onToolResult}
          contextResource={selected}
          onClearContext={() => setSelected(null)}
          pendingPrompt={pendingPrompt}
          onPendingConsumed={() => setPendingPrompt(null)}
        />
      </aside>
      <section className="flex-1 min-w-0 flex flex-col min-h-0">
        <TabBar value={middleTab} onChange={setMiddleTab} />
        {middleTab === "list" && (
          <ResourceTree
            selected={selected}
            onSelect={(r, c) => {
              setSelected(r);
              setSelectedComponent(c);
            }}
            onAddToComponent={(c) => setPendingPrompt(addToComponentPrompt(c))}
            refreshKey={refreshKey}
          />
        )}
        {middleTab === "plan" && (
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
        {middleTab === "blueprint" && (
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
            existingReloadKey={blueprintReload}
            onDiscover={(scope) => setPendingPrompt(discoveryPrompt(scope))}
            onAdopted={() => setBlueprintReload((k) => k + 1)}
          />
        )}
      </section>
      <aside className="w-[420px] shrink-0 border-l border-border flex flex-col min-h-0">
        {middleTab === "blueprint" ? (
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
        ) : (
          <ResourceDrawer
            resource={selected}
            change={selectedChange}
            onClose={() => setSelected(null)}
            onOpenInPlanDiff={openInPlanDiff}
            component={selectedComponent}
            onReassign={handleReassign}
          />
        )}
      </aside>
    </main>
  );
}

function TabBar({
  value,
  onChange,
}: {
  value: MiddleTab;
  onChange: (next: MiddleTab) => void;
}) {
  return (
    <div className="flex items-center gap-1 px-3 h-8 border-b border-border bg-background shrink-0">
      <TabButton active={value === "list"} onClick={() => onChange("list")}>
        list
      </TabButton>
      <span className="text-border text-[10px]">|</span>
      <TabButton active={value === "plan"} onClick={() => onChange("plan")}>
        plan diff
      </TabButton>
      <span className="text-border text-[10px]">|</span>
      <TabButton active={value === "blueprint"} onClick={() => onChange("blueprint")}>
        blueprint
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
