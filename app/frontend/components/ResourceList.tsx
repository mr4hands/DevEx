"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchPlan } from "@/lib/api";
import {
  FAMILY_CLASSES,
  familyOf,
  leafOf,
} from "@/lib/resourceFamilies";
import type { PlanResponse, Resource } from "@/lib/types";

type Group = {
  /** Stable key: `<type>::<module>`. Same type under different modules splits. */
  key: string;
  type: string;
  module: string;
  resources: Resource[];
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
  const [filterOpen, setFilterOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, refreshKey]);

  // Regroup the backend's type-grouped payload by (type, module) so that
  // the same type under different modules renders as separate sticky
  // sections. Cleaner UX in multi-module repos.
  const groups = useMemo<Group[]>(() => {
    if (!plan) return [];
    const buckets = new Map<string, Group>();
    for (const g of plan.groups) {
      for (const r of g.resources) {
        const key = `${r.type}::${r.module || ""}`;
        if (!buckets.has(key)) {
          buckets.set(key, {
            key,
            type: r.type,
            module: r.module || "",
            resources: [],
          });
        }
        buckets.get(key)!.resources.push(r);
      }
    }
    return [...buckets.values()].sort((a, b) => {
      // Sort by module first (root first), then type.
      if (a.module !== b.module) return a.module.localeCompare(b.module);
      return a.type.localeCompare(b.type);
    });
  }, [plan]);

  const filteredGroups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return groups;
    return groups
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
  }, [groups, filter]);

  const totalCount = plan?.resource_count ?? 0;
  const visibleCount = filteredGroups.reduce(
    (acc, g) => acc + g.resources.length,
    0,
  );

  const toggleGroup = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => {
    setCollapsed(new Set(groups.map((g) => g.key)));
  }, [groups]);

  const expandAll = useCallback(() => setCollapsed(new Set()), []);

  const allCollapsed = collapsed.size === groups.length && groups.length > 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Top bar */}
      <div className="flex items-center justify-between px-3 h-8 border-b border-border text-[11px] shrink-0">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="font-mono text-foreground tabular-nums">
            {loading ? "…" : visibleCount === totalCount ? totalCount : `${visibleCount}/${totalCount}`}
          </span>
          <span>resources</span>
        </div>
        <div className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
          <button
            type="button"
            className={`px-1.5 h-5 rounded-sm transition-colors hover:bg-muted ${
              filterOpen || filter ? "text-foreground" : ""
            }`}
            onClick={() => setFilterOpen((v) => !v)}
          >
            filter{filter ? `: ${filter.length > 8 ? filter.slice(0, 8) + "…" : filter}` : ""}
          </button>
          <span className="text-border">·</span>
          <button
            type="button"
            className="px-1.5 h-5 rounded-sm transition-colors hover:bg-muted"
            onClick={allCollapsed ? expandAll : collapseAll}
            disabled={groups.length === 0}
          >
            {allCollapsed ? "expand all" : "collapse all"}
          </button>
          <span className="text-border">·</span>
          <button
            type="button"
            className="px-1.5 h-5 rounded-sm transition-colors hover:bg-muted"
            onClick={load}
            disabled={loading}
          >
            {loading ? "…" : "refresh"}
          </button>
        </div>
      </div>

      {/* Filter input — slides in when active */}
      {filterOpen && (
        <div className="px-3 py-1.5 border-b border-border shrink-0">
          <input
            autoFocus
            className="w-full rounded-sm border border-border bg-background px-2 py-1 text-xs font-mono outline-none focus:border-accent"
            placeholder="filter by address, type, module…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setFilter("");
                setFilterOpen(false);
              }
            }}
          />
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {error && (
          <div className="m-3 text-xs rounded-sm border border-red-200 dark:border-red-900 px-3 py-2 text-red-600 dark:text-red-400">
            {error}
          </div>
        )}
        {!error && !loading && totalCount === 0 && (
          <p className="m-3 text-xs text-muted-foreground">
            No resources yet. Run <code className="font-mono">make plan-dev</code> after applying.
          </p>
        )}
        {!error && filteredGroups.length === 0 && totalCount > 0 && (
          <p className="m-3 text-xs text-muted-foreground">No matches.</p>
        )}
        {filteredGroups.map((g) => (
          <GroupSection
            key={g.key}
            group={g}
            collapsed={collapsed.has(g.key)}
            selected={selected}
            onToggle={() => toggleGroup(g.key)}
            onSelect={onSelect}
          />
        ))}
      </div>

      {/* Footer pin */}
      <FooterPin selected={selected} />
    </div>
  );
}

function GroupSection({
  group,
  collapsed,
  selected,
  onToggle,
  onSelect,
}: {
  group: Group;
  collapsed: boolean;
  selected: Resource | null;
  onToggle: () => void;
  onSelect: (r: Resource) => void;
}) {
  const meta = familyOf(group.type);
  const classes = FAMILY_CLASSES[meta.family];

  return (
    <section>
      <header
        className="sticky top-0 z-10 flex items-center gap-2.5 pl-2 pr-3 h-8 bg-background/95 backdrop-blur border-y border-border cursor-pointer select-none"
        onClick={onToggle}
      >
        <span className="inline-flex items-center justify-center w-4 h-4 text-muted-foreground">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="9"
            height="9"
            viewBox="0 0 10 10"
            fill="none"
            className={`transition-transform ${collapsed ? "" : "rotate-90"}`}
          >
            <path
              d="M3 2l4 3-4 3"
              stroke="currentColor"
              strokeWidth="1.2"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span
          className={`inline-flex items-center justify-center px-1.5 h-[20px] min-w-[28px] rounded-sm ring-1 ring-inset font-mono text-[11px] uppercase ${classes.chip}`}
        >
          {meta.monogram}
        </span>
        <span className="font-mono text-xs text-foreground font-medium truncate">
          {group.type}
        </span>
        {group.module && (
          <>
            <span className="text-[10px] font-mono text-border">·</span>
            <span className="font-mono text-[11px] text-muted-foreground truncate">
              {group.module}
            </span>
          </>
        )}
        <span className="ml-auto flex items-center gap-2">
          <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
            {group.resources.length}
          </span>
        </span>
      </header>

      {collapsed ? (
        <div className="pl-7 pr-3 h-7 flex items-center text-[10px] font-mono text-muted-foreground border-b border-border">
          {group.resources.length} hidden
        </div>
      ) : (
        <ul>
          {group.resources.map((r) => (
            <ResourceRow
              key={r.address}
              resource={r}
              selected={selected?.address === r.address}
              railClass={classes.rail}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ResourceRow({
  resource,
  selected,
  railClass,
  onSelect,
}: {
  resource: Resource;
  selected: boolean;
  railClass: string;
  onSelect: (r: Resource) => void;
}) {
  const leaf = leafOf(resource.address);

  if (selected) {
    return (
      <li className="relative flex items-start gap-2 pl-7 pr-3 py-1.5 bg-amber-50/60 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900">
        <span
          className={`absolute left-3 top-1.5 bottom-1.5 w-[2px] ${railClass}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-amber-900 dark:text-amber-200 font-medium">
              {leaf}
            </span>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span
              className="font-mono text-[10.5px] text-muted-foreground truncate min-w-0 flex-1"
              title={resource.address}
            >
              {resource.address}
            </span>
            <CopyButton value={resource.address} />
          </div>
        </div>
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(resource)}
        className="group relative flex items-center gap-2 pl-7 pr-3 h-7 w-full text-left cursor-pointer hover:bg-muted transition-colors border-b border-border"
      >
        <span className={`absolute left-3 top-1 bottom-1 w-[2px] ${railClass}`} />
        <span
          className="font-mono text-xs text-foreground truncate min-w-0 flex-1"
          title={resource.address}
        >
          {leaf}
        </span>
      </button>
    </li>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label="Copy address"
      title={copied ? "Copied!" : "Copy address"}
      className="shrink-0 inline-flex items-center justify-center w-4 h-4 border border-border text-muted-foreground hover:text-foreground hover:bg-background rounded-sm transition-colors"
    >
      {copied ? (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="9"
          height="9"
          viewBox="0 0 12 12"
          fill="none"
        >
          <path
            d="M2 6.5l2.5 2.5L10 3"
            stroke="currentColor"
            strokeWidth="1.4"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="9"
          height="9"
          viewBox="0 0 12 12"
          fill="none"
        >
          <rect
            x="3"
            y="3"
            width="7"
            height="7"
            rx="1"
            stroke="currentColor"
            strokeWidth="1.1"
          />
          <path
            d="M2 8V2.5A.5.5 0 0 1 2.5 2H8"
            stroke="currentColor"
            strokeWidth="1.1"
          />
        </svg>
      )}
    </button>
  );
}

function FooterPin({ selected }: { selected: Resource | null }) {
  return (
    <div className="shrink-0 border-t border-border px-3 h-7 flex items-center gap-2 bg-muted/50 text-[10px] font-mono text-muted-foreground">
      <span className="text-muted-foreground uppercase tracking-wide">selected</span>
      {selected ? (
        <>
          <span className="text-foreground truncate" title={selected.address}>
            {selected.address}
          </span>
          <CopyButton value={selected.address} />
        </>
      ) : (
        <span className="opacity-60">(none — click a row)</span>
      )}
    </div>
  );
}
