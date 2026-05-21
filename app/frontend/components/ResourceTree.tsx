"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchInventory } from "@/lib/api";
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

/** Map an inventory item to the Resource shape the drawer expects. */
function toResource(r: InventoryResource): Resource {
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
  refreshKey,
}: {
  selected: Resource | null;
  onSelect: (r: Resource) => void;
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
        <button
          type="button"
          className="px-1.5 h-5 rounded-sm font-mono text-[10px] text-muted-foreground hover:bg-muted"
          onClick={() => load()}
          disabled={loading}
        >
          refresh
        </button>
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
                            onSelect={() => onSelect(toResource(r))}
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
  children,
}: {
  id: string;
  label: string;
  kind: "account" | "region" | "component" | "type";
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}) {
  const isCollapsed = collapsed.has(id);
  const indent = { account: 0, region: 12, component: 24, type: 36 }[kind];
  return (
    <div>
      <button
        type="button"
        onClick={() => onToggle(id)}
        style={{ paddingLeft: indent + 8 }}
        className="w-full flex items-center gap-1.5 h-6 pr-2 text-left hover:bg-muted border-b border-border font-mono"
      >
        <span className={`transition-transform ${isCollapsed ? "" : "rotate-90"}`}>
          ›
        </span>
        <span className={kind === "component" ? "font-semibold" : ""}>{label}</span>
      </button>
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
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{ paddingLeft: 56 }}
      className={`w-full flex items-center gap-2 h-6 pr-2 text-left border-b border-border font-mono ${
        selected ? "bg-amber-50/60 dark:bg-amber-950/30" : "hover:bg-muted"
      }`}
    >
      <span className={`w-[2px] self-stretch my-1 ${classes.rail}`} />
      <span className="truncate flex-1">{item.name}</span>
      <span
        className={`px-1 rounded-sm text-[9px] ${
          item.managed
            ? "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300"
            : "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
        }`}
      >
        {item.managed ? "mgd" : "unmgd"}
      </span>
    </button>
  );
}
