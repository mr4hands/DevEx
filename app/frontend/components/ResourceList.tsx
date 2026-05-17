"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchPlan } from "@/lib/api";
import type { PlanResponse, Resource } from "@/lib/types";

export type ResourceListHandle = {
  refresh: () => void;
};

export function ResourceList({
  selected,
  onSelect,
  refreshKey,
}: {
  selected: Resource | null;
  onSelect: (r: Resource) => void;
  refreshKey?: number;
}) {
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPlan(await fetchPlan());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Fetch-on-mount + refresh-on-key. The lint rule below targets effects that
    // sync external state into React state; this is the standard initial-load
    // pattern, which the rule docs acknowledge as a fine exception.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, refreshKey]);

  const filteredGroups = useMemo(() => {
    if (!plan) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return plan.groups;
    return plan.groups
      .map((g) => ({
        ...g,
        resources: g.resources.filter(
          (r) =>
            r.address.toLowerCase().includes(q) ||
            r.type.toLowerCase().includes(q) ||
            r.module.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.resources.length > 0);
  }, [plan, filter]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <div className="flex-1">
          <h2 className="text-sm font-semibold">Resources</h2>
          <p className="text-xs text-muted-foreground">
            {plan
              ? `${plan.resource_count} from ${plan.tofu_root.split("/").slice(-2).join("/")}`
              : "loading…"}
          </p>
        </div>
        <button
          type="button"
          className="rounded border border-border bg-muted px-2 py-1 text-xs hover:border-accent"
          onClick={load}
          disabled={loading}
        >
          {loading ? "…" : "Refresh"}
        </button>
      </div>

      <div className="px-4 py-2 border-b border-border">
        <input
          className="w-full rounded border border-border bg-background px-2 py-1 text-sm outline-none focus:border-accent"
          placeholder="Filter by address, type, module…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="m-4 text-xs rounded border border-red-200 dark:border-red-900 px-3 py-2 text-red-600 dark:text-red-400">
            {error}
          </div>
        )}
        {!error && !loading && plan?.resource_count === 0 && (
          <p className="m-4 text-sm text-muted-foreground">
            No resources yet. Run <code>make plan-dev</code> after applying.
          </p>
        )}
        {filteredGroups.map((g) => (
          <section key={g.type} className="">
            <header className="sticky top-0 bg-background/95 backdrop-blur px-4 py-1.5 text-[11px] font-mono uppercase tracking-wide text-muted-foreground border-b border-border">
              {g.type} · {g.resources.length}
            </header>
            <ul>
              {g.resources.map((r) => (
                <li key={r.address}>
                  <button
                    type="button"
                    onClick={() => onSelect(r)}
                    className={`w-full text-left px-4 py-2 text-sm border-b border-border hover:bg-muted transition-colors ${
                      selected?.address === r.address ? "bg-muted" : ""
                    }`}
                  >
                    <div className="font-mono text-xs truncate">{r.address}</div>
                    {r.module && (
                      <div className="text-[11px] text-muted-foreground truncate">
                        {r.module}
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
