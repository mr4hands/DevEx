"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchInventory } from "@/lib/api";
import { EXISTING_DRAG_TYPE } from "@/lib/blueprintPalette";
import { FAMILY_CLASSES, familyOf } from "@/lib/resourceFamilies";
import type { InventoryResource, Resource } from "@/lib/types";

/** Builds the nested Account -> Region -> Component -> type -> resource
 *  structure from the flat inventory. Unassigned sorts last. */
type TypeGroup = { type: string; resources: InventoryResource[] };
type ComponentGroup = { component: string; types: TypeGroup[] };
type RegionGroup = { region: string; components: ComponentGroup[] };
type AccountGroup = { account: string; regions: RegionGroup[] };

function groupBy<T>(arr: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of arr) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(x);
  }
  return m;
}

function sortKeys(keys: string[]): string[] {
  return keys.sort((a, b) =>
    a === "Unassigned" ? 1 : b === "Unassigned" ? -1 : a.localeCompare(b),
  );
}

function groupInventory(items: InventoryResource[]): AccountGroup[] {
  const accounts: AccountGroup[] = [];
  const byAccount = groupBy(items, (r) => r.account);
  for (const account of sortKeys([...byAccount.keys()])) {
    const regions: RegionGroup[] = [];
    const byRegion = groupBy(byAccount.get(account)!, (r) => r.region);
    for (const region of sortKeys([...byRegion.keys()])) {
      const components: ComponentGroup[] = [];
      const byComp = groupBy(byRegion.get(region)!, (r) => r.component);
      for (const component of sortKeys([...byComp.keys()])) {
        const types: TypeGroup[] = [];
        const byType = groupBy(byComp.get(component)!, (r) => r.type);
        for (const type of [...byType.keys()].sort()) {
          types.push({ type, resources: byType.get(type)! });
        }
        components.push({ component, types });
      }
      regions.push({ region, components });
    }
    accounts.push({ account, regions });
  }
  return accounts;
}

/** Map an inventory item to the Resource shape the drawer/chat expect. */
export function inventoryToResource(r: InventoryResource): Resource {
  return {
    address: r.address,
    type: r.type,
    name: r.name,
    module: "",
    mode: r.managed ? "managed" : "unmanaged",
    provider: "",
    values: r.values,
  };
}

export function ResourceTree({
  selected,
  onSelect,
  onAddToComponent,
  onDiscover,
  refreshKey,
}: {
  selected: Resource | null;
  /** Fires with the full inventory item so the inspector can act on its
   *  state/draft/component. */
  onSelect: (item: InventoryResource) => void;
  /** Fired by a component node's "+add" button — the parent seeds an agent
   *  prompt to add resources to that component. */
  onAddToComponent?: (component: string) => void;
  /** Fired by the "discover" button — the parent seeds an agent run that
   *  enumerates AWS and writes the discovery manifest. */
  onDiscover?: (scope: string) => void;
  refreshKey?: number;
}) {
  const [items, setItems] = useState<InventoryResource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchInventory(signal);
      setItems(res.resources);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(ac.signal);
    return () => ac.abort();
  }, [load, refreshKey]);

  const tree = useMemo(() => groupInventory(items), [items]);
  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-3 h-8 border-b border-border text-[11px] shrink-0">
        <span className="text-muted-foreground">
          {loading ? "…" : `${items.length} resources`}
        </span>
        <div className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
          {onDiscover && (
            <button
              type="button"
              className="px-1.5 h-5 rounded-sm hover:bg-muted"
              title="Ask the agent to discover unmanaged AWS resources"
              onClick={() => onDiscover("all")}
            >
              discover
            </button>
          )}
          <button
            type="button"
            className="px-1.5 h-5 rounded-sm hover:bg-muted"
            onClick={() => load()}
            disabled={loading}
          >
            refresh
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0 text-[11px]">
        {error && (
          <p className="m-2 text-red-600 dark:text-red-400 break-words">{error}</p>
        )}
        {!error && items.length === 0 && !loading && (
          <p className="m-2 text-muted-foreground">No resources found.</p>
        )}
        {tree.map((acct) => (
          <TreeBranch
            key={acct.account}
            id={`a:${acct.account}`}
            label={acct.account}
            kind="account"
            collapsed={collapsed}
            onToggle={toggle}
          >
            {acct.regions.map((reg) => (
              <TreeBranch
                key={reg.region}
                id={`a:${acct.account}/r:${reg.region}`}
                label={reg.region}
                kind="region"
                collapsed={collapsed}
                onToggle={toggle}
              >
                {reg.components.map((comp) => (
                  <TreeBranch
                    key={comp.component}
                    id={`${acct.account}/${reg.region}/c:${comp.component}`}
                    label={comp.component}
                    kind="component"
                    collapsed={collapsed}
                    onToggle={toggle}
                    action={
                      onAddToComponent && comp.component !== "Unassigned" ? (
                        <button
                          type="button"
                          title={`Ask the agent to add resources to ${comp.component}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onAddToComponent(comp.component);
                          }}
                          className="shrink-0 px-1.5 h-5 text-[11px] font-mono text-emerald-700 dark:text-emerald-400 hover:bg-muted rounded-sm"
                        >
                          ＋
                        </button>
                      ) : null
                    }
                  >
                    {comp.types.map((tg) => (
                      <TreeBranch
                        key={tg.type}
                        id={`${acct.account}/${reg.region}/${comp.component}/t:${tg.type}`}
                        label={`${tg.type} (${tg.resources.length})`}
                        kind="type"
                        collapsed={collapsed}
                        onToggle={toggle}
                      >
                        {tg.resources.map((r) => (
                          <ResourceRow
                            key={r.address}
                            item={r}
                            selected={selected?.address === r.address}
                            onSelect={() => onSelect(r)}
                          />
                        ))}
                      </TreeBranch>
                    ))}
                  </TreeBranch>
                ))}
              </TreeBranch>
            ))}
          </TreeBranch>
        ))}
      </div>
    </div>
  );
}

function TreeBranch({
  id,
  label,
  kind,
  collapsed,
  onToggle,
  action,
  children,
}: {
  id: string;
  label: string;
  kind: "account" | "region" | "component" | "type";
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const isCollapsed = collapsed.has(id);
  const indent = { account: 0, region: 12, component: 24, type: 36 }[kind];
  return (
    <div>
      <div className="w-full flex items-center pr-2 border-b border-border hover:bg-muted">
        <button
          type="button"
          onClick={() => onToggle(id)}
          style={{ paddingLeft: indent + 8 }}
          className="flex-1 min-w-0 flex items-center gap-1.5 h-6 text-left font-mono"
        >
          <span className={`transition-transform ${isCollapsed ? "" : "rotate-90"}`}>
            ›
          </span>
          <span className={`truncate ${kind === "component" ? "font-semibold" : ""}`}>
            {label}
          </span>
        </button>
        {action}
      </div>
      {!isCollapsed && children}
    </div>
  );
}

function ResourceRow({
  item,
  selected,
  onSelect,
}: {
  item: InventoryResource;
  selected: boolean;
  onSelect: () => void;
}) {
  const meta = familyOf(item.type);
  const classes = FAMILY_CLASSES[meta.family];
  // Unmanaged resources can be dragged onto the canvas to adopt them
  // (import). Managed/planned rows aren't adoptable, so they don't drag.
  const adoptable = item.state === "unmanaged" && !!item.id;
  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(
      EXISTING_DRAG_TYPE,
      JSON.stringify({
        type: item.type,
        name: item.name,
        import_id: item.id,
        summary_attributes: item.values,
      }),
    );
    e.dataTransfer.effectAllowed = "copy";
  };
  return (
    <button
      type="button"
      onClick={onSelect}
      draggable={adoptable}
      onDragStart={adoptable ? onDragStart : undefined}
      title={
        adoptable
          ? `Drag onto the canvas to adopt ${item.address}`
          : item.address
      }
      style={{ paddingLeft: 56 }}
      className={`w-full flex items-center gap-2 h-6 pr-2 text-left border-b border-border font-mono ${
        selected ? "bg-amber-50/60 dark:bg-amber-950/30" : "hover:bg-muted"
      } ${adoptable ? "cursor-grab active:cursor-grabbing" : ""}`}
    >
      <span className={`w-[2px] self-stretch my-1 ${classes.rail}`} />
      <span className="truncate flex-1">{item.name}</span>
      <StateBadge state={item.state} />
    </button>
  );
}

function StateBadge({ state }: { state: string }) {
  const meta: Record<string, { label: string; cls: string }> = {
    managed: {
      label: "mgd",
      cls: "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300",
    },
    unmanaged: {
      label: "unmgd",
      cls: "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    },
    planned: {
      label: "plan",
      cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
    },
  };
  const m = meta[state] ?? {
    label: state,
    cls: "bg-muted text-muted-foreground",
  };
  return <span className={`px-1 rounded-sm text-[9px] ${m.cls}`}>{m.label}</span>;
}
