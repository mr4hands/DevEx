"use client";

import { useCallback, useState } from "react";

import { ChatPanel } from "@/components/ChatPanel";
import { ResourceDrawer } from "@/components/ResourceDrawer";
import { ResourceList } from "@/components/ResourceList";
import type { Resource } from "@/lib/types";

export default function Home() {
  const [selected, setSelected] = useState<Resource | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const onToolResult = useCallback(() => {
    // Refresh on every tool result — the agent has Edit/Write/Bash now, so
    // any tool call could have mutated state worth re-rendering.
    setRefreshKey((k) => k + 1);
  }, []);

  return (
    <main className="flex flex-1 min-h-0 h-screen">
      <aside className="w-[360px] shrink-0 border-r border-border flex flex-col min-h-0">
        <ChatPanel onToolResult={onToolResult} />
      </aside>
      <section className="flex-1 min-w-0 flex flex-col min-h-0">
        <ResourceList
          selected={selected}
          onSelect={setSelected}
          refreshKey={refreshKey}
        />
      </section>
      <aside className="w-[420px] shrink-0 border-l border-border flex flex-col min-h-0">
        <ResourceDrawer resource={selected} onClose={() => setSelected(null)} />
      </aside>
    </main>
  );
}
