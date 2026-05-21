"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchDrafts } from "@/lib/api";
import type { Draft } from "@/lib/types";

/**
 * Slim bar summarizing the current owner's pending drafts, grouped by
 * component, with a "commit to PR" action. Renders nothing when there are
 * no drafts. Refetches whenever `refreshKey` changes.
 */
export function PendingChanges({
  refreshKey,
  onCommit,
}: {
  refreshKey?: number;
  onCommit: () => void;
}) {
  const [drafts, setDrafts] = useState<Draft[]>([]);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetchDrafts(signal);
      setDrafts(res.drafts);
    } catch {
      /* non-fatal — the bar just stays empty */
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(ac.signal);
    return () => ac.abort();
  }, [load, refreshKey]);

  const byComponent = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of drafts) {
      const c = d.component || "Unassigned";
      m.set(c, (m.get(c) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [drafts]);

  if (drafts.length === 0) return null;

  return (
    <div className="shrink-0 border-b border-border bg-amber-50/60 dark:bg-amber-950/30 px-3 py-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-mono text-amber-800 dark:text-amber-300">
          {drafts.length} pending
        </span>
        <span className="flex-1 min-w-0 truncate text-[10px] font-mono text-muted-foreground">
          {byComponent.map(([c, n]) => `${c} ${n}`).join(" · ")}
        </span>
        <button
          type="button"
          onClick={onCommit}
          className="shrink-0 h-6 px-2 inline-flex items-center justify-center text-[10px] font-medium rounded-sm bg-accent text-white hover:opacity-90 transition-colors"
        >
          commit to PR
        </button>
      </div>
    </div>
  );
}
