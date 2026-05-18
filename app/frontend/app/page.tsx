"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChatPanel } from "@/components/ChatPanel";
import { PlanDiff } from "@/components/PlanDiff";
import { ResourceDrawer } from "@/components/ResourceDrawer";
import { ResourceList } from "@/components/ResourceList";
import { fetchPlanDiff } from "@/lib/api";
import type { PlanDiffResponse, Resource, ResourceChange } from "@/lib/types";

type MiddleTab = "list" | "plan";

export default function Home() {
  const [selected, setSelected] = useState<Resource | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [middleTab, setMiddleTab] = useState<MiddleTab>("list");

  // Hoisted plan-diff state — shared across PlanDiff, ResourceList
  // (pending indicators), and ResourceDrawer (in-plan strip + change).
  const [planDiff, setPlanDiff] = useState<PlanDiffResponse | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  // When the user clicks "open in PlanDiff" from the drawer, we route
  // them to the Plan tab + expand that row.
  const [planFocusAddress, setPlanFocusAddress] = useState<string | null>(null);
  const planAbortRef = useRef<AbortController | null>(null);

  const runPlan = useCallback(async () => {
    planAbortRef.current?.abort();
    const ac = new AbortController();
    planAbortRef.current = ac;
    setPlanLoading(true);
    setPlanError(null);
    try {
      setPlanDiff(await fetchPlanDiff(ac.signal));
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setPlanError((e as Error).message);
    } finally {
      if (planAbortRef.current === ac) {
        setPlanLoading(false);
        planAbortRef.current = null;
      }
    }
  }, []);

  // Run an initial plan on mount so pending indicators are populated
  // before the user has to click anything.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void runPlan();
    return () => planAbortRef.current?.abort();
  }, [runPlan]);

  const onToolResult = useCallback(() => {
    // Refresh on every tool result — agent may have mutated state.
    // (Plan tab does not auto-refresh; user re-triggers via "run plan".)
    setRefreshKey((k) => k + 1);
  }, []);

  // Index plan-diff changes by address for cheap lookups.
  const changesByAddress = useMemo(() => {
    const m = new Map<string, ResourceChange>();
    if (planDiff) {
      for (const c of planDiff.changes) m.set(c.address, c);
    }
    return m;
  }, [planDiff]);

  const pendingByAddress = useMemo(() => {
    const m = new Map<string, string>();
    for (const [addr, change] of changesByAddress) {
      m.set(addr, change.action_kind);
    }
    return m;
  }, [changesByAddress]);

  const selectedChange = selected
    ? changesByAddress.get(selected.address) ?? null
    : null;

  const openInPlanDiff = useCallback((r: Resource) => {
    setPlanFocusAddress(r.address);
    setMiddleTab("plan");
  }, []);

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
        />
      </aside>
      <section className="flex-1 min-w-0 flex flex-col min-h-0">
        <TabBar value={middleTab} onChange={setMiddleTab} />
        {middleTab === "list" ? (
          <ResourceList
            selected={selected}
            onSelect={setSelected}
            refreshKey={refreshKey}
            pendingByAddress={pendingByAddress}
          />
        ) : (
          <PlanDiff
            diff={planDiff}
            loading={planLoading}
            error={planError}
            onRunPlan={runPlan}
            focusAddress={planFocusAddress}
          />
        )}
      </section>
      <aside className="w-[420px] shrink-0 border-l border-border flex flex-col min-h-0">
        <ResourceDrawer
          resource={selected}
          change={selectedChange}
          onClose={() => setSelected(null)}
          onOpenInPlanDiff={openInPlanDiff}
        />
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
