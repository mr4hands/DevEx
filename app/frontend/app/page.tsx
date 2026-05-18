"use client";

import { useCallback, useState } from "react";

import { ChatPanel } from "@/components/ChatPanel";
import { PlanDiff } from "@/components/PlanDiff";
import { ResourceDrawer } from "@/components/ResourceDrawer";
import { ResourceList } from "@/components/ResourceList";
import type { Resource } from "@/lib/types";

type MiddleTab = "state" | "plan";

export default function Home() {
  const [selected, setSelected] = useState<Resource | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [middleTab, setMiddleTab] = useState<MiddleTab>("state");

  const onToolResult = useCallback(() => {
    // Refresh on every tool result — the agent has Edit/Write/Bash now, so
    // any tool call could have mutated state worth re-rendering. The Plan
    // tab does not auto-refresh on this signal: `tofu plan` is slow and
    // most tool calls don't warrant a fresh plan; the user re-triggers it
    // explicitly via the "Run plan" button.
    setRefreshKey((k) => k + 1);
  }, []);

  return (
    <main className="flex flex-1 min-h-0 h-screen">
      <aside className="w-[360px] shrink-0 border-r border-border flex flex-col min-h-0">
        <ChatPanel onToolResult={onToolResult} />
      </aside>
      <section className="flex-1 min-w-0 flex flex-col min-h-0">
        <TabBar value={middleTab} onChange={setMiddleTab} />
        {middleTab === "state" ? (
          <ResourceList
            selected={selected}
            onSelect={setSelected}
            refreshKey={refreshKey}
          />
        ) : (
          <PlanDiff />
        )}
      </section>
      <aside className="w-[420px] shrink-0 border-l border-border flex flex-col min-h-0">
        <ResourceDrawer resource={selected} onClose={() => setSelected(null)} />
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
    <div className="flex border-b border-border bg-background">
      <TabButton active={value === "state"} onClick={() => onChange("state")}>
        State
      </TabButton>
      <TabButton active={value === "plan"} onClick={() => onChange("plan")}>
        Plan
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
      className={`px-4 py-2 text-sm transition-colors border-b-2 ${
        active
          ? "border-accent text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
