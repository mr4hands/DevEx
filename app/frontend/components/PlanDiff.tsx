"use client";

import { useCallback, useMemo, useState } from "react";

import { expandChanges, fmtValue } from "@/lib/resourceFields";
import type { ActionKind, PlanDiffResponse, ResourceChange } from "@/lib/types";

/**
 * Pending changes from `tofu plan`, grouped by module (Claude Design
 * Session 2 Variant B — the visual). Each row is one resource; expanding
 * a row reveals an inline tree-style diff of changed attributes.
 *
 * Presentational only — data + loading state come in as props (owned by
 * page.tsx so they're shared with ResourceList and ResourceDrawer).
 *
 * Action-kind colors and glyphs are kept consistent with `ResourceDrawer`:
 *   create  → "+"  emerald
 *   update  → "~"  amber
 *   delete  → "-"  red
 *   replace → "±"  red  (with "forces new" badge)
 *   import  → "←"  sky
 */

type ActionMeta = {
  glyph: string;
  label: string;
  className: string;
  rail: string;
  forcesNew?: boolean;
};

const ACTION_META: Record<string, ActionMeta> = {
  create: {
    glyph: "+",
    label: "create",
    className:
      "text-emerald-700 bg-emerald-50 ring-emerald-200 dark:text-emerald-300 dark:bg-emerald-950 dark:ring-emerald-900",
    rail: "bg-emerald-400 dark:bg-emerald-700",
  },
  update: {
    glyph: "~",
    label: "update",
    className:
      "text-amber-800 bg-amber-50 ring-amber-200 dark:text-amber-300 dark:bg-amber-950 dark:ring-amber-900",
    rail: "bg-amber-400 dark:bg-amber-700",
  },
  delete: {
    glyph: "-",
    label: "destroy",
    className:
      "text-red-700 bg-red-50 ring-red-200 dark:text-red-300 dark:bg-red-950 dark:ring-red-900",
    rail: "bg-red-400 dark:bg-red-700",
  },
  replace: {
    glyph: "±",
    label: "replace",
    className:
      "text-red-700 bg-red-50 ring-red-200 dark:text-red-300 dark:bg-red-950 dark:ring-red-900",
    rail: "bg-red-400 dark:bg-red-700",
    forcesNew: true,
  },
  import: {
    glyph: "←",
    label: "import",
    className:
      "text-sky-700 bg-sky-50 ring-sky-200 dark:text-sky-300 dark:bg-sky-950 dark:ring-sky-900",
    rail: "bg-sky-400 dark:bg-sky-700",
  },
  import_update: {
    glyph: "←~",
    label: "import + update",
    className:
      "text-sky-700 bg-sky-50 ring-sky-200 dark:text-sky-300 dark:bg-sky-950 dark:ring-sky-900",
    rail: "bg-sky-400 dark:bg-sky-700",
  },
};

function metaFor(kind: ActionKind): ActionMeta {
  return (
    ACTION_META[kind] ?? {
      glyph: "?",
      label: kind,
      className: "text-muted-foreground bg-muted ring-border",
      rail: "bg-border",
    }
  );
}

const ORDERED_KINDS: ActionKind[] = ["import", "create", "update", "replace", "delete"];

export function PlanDiff({
  diff,
  loading,
  error,
  onRunPlan,
  focusAddress,
  root,
  onRootChange,
  leaf,
  onLeafChange,
  leaves,
}: {
  diff: PlanDiffResponse | null;
  loading: boolean;
  error: string | null;
  onRunPlan: () => void;
  /** When set, the matching row auto-expands (used by the drawer's
   *  "open in PlanDiff" deep-link). */
  focusAddress?: string | null;
  /** Which workspace the plan is currently against. The plan tab can
   *  flip between the deployed `live/dev` workspace and the canvas's
   *  `live/blueprint` so the user can preview what their blueprint
   *  would do on apply. */
  root?: "default" | "blueprint";
  onRootChange?: (next: "default" | "blueprint") => void;
  /** When root==="blueprint", the currently-selected leaf (or null for whole
   *  blueprint). */
  leaf?: string | null;
  onLeafChange?: (leaf: string | null) => void;
  /** Staged leaves available for per-leaf preview. */
  leaves?: string[];
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsedModules, setCollapsedModules] = useState<Set<string>>(new Set());

  const moduleGroups = useMemo(() => {
    if (!diff) return [] as { module: string; changes: ResourceChange[] }[];
    const buckets = new Map<string, ResourceChange[]>();
    for (const c of diff.changes) {
      const m = c.module || "(root)";
      if (!buckets.has(m)) buckets.set(m, []);
      buckets.get(m)!.push(c);
    }
    return [...buckets.entries()]
      .map(([module_, changes]) => ({
        module: module_,
        changes: [...changes].sort((a, b) => a.address.localeCompare(b.address)),
      }))
      .sort((a, b) => a.module.localeCompare(b.module));
  }, [diff]);

  const toggleRow = useCallback((addr: string) => {
    setExpanded((p) => {
      const next = new Set(p);
      if (next.has(addr)) next.delete(addr);
      else next.add(addr);
      return next;
    });
  }, []);

  const toggleModule = useCallback((m: string) => {
    setCollapsedModules((p) => {
      const next = new Set(p);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => {
    setCollapsedModules(new Set(moduleGroups.map((g) => g.module)));
  }, [moduleGroups]);

  const expandAll = useCallback(() => setCollapsedModules(new Set()), []);
  const allCollapsed =
    collapsedModules.size === moduleGroups.length && moduleGroups.length > 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Top summary bar */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-border bg-muted/50 shrink-0">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">plan</span>
        <div className="flex items-center gap-1 flex-wrap">
          {ORDERED_KINDS.map((kind) => {
            const n = diff?.counts[kind] ?? 0;
            const meta = metaFor(kind);
            const muted = n === 0;
            return (
              <span
                key={kind}
                className={
                  "inline-flex items-center gap-1 px-1.5 h-[20px] rounded-sm ring-1 ring-inset font-mono text-[11px] " +
                  (muted ? "text-muted-foreground bg-muted ring-border" : meta.className)
                }
              >
                <span className="font-medium tabular-nums">{n}</span>
                <span className="font-sans text-[10px] uppercase tracking-wide">
                  {meta.label}
                </span>
              </span>
            );
          })}
        </div>
        <span className="ml-auto text-[10px] font-mono text-muted-foreground tabular-nums">
          {diff
            ? `${diff.visible_changes} change${diff.visible_changes === 1 ? "" : "s"} · ${diff.total_changes - diff.visible_changes} unchanged`
            : loading
              ? "running tofu plan…"
              : "—"}
        </span>
      </div>

      {/* Sub-bar */}
      <div className="flex items-center justify-between px-3 h-8 border-b border-border text-[11px] shrink-0">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="font-mono text-foreground tabular-nums">
            {moduleGroups.length}
          </span>
          <span>module{moduleGroups.length === 1 ? "" : "s"}</span>
          <span className="text-border">·</span>
          <span className="font-mono text-muted-foreground">grouped</span>
        </div>
        <div className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
          {onRootChange && (
            <>
              <button
                type="button"
                onClick={() => onRootChange("default")}
                className={`px-1.5 h-5 rounded-sm transition-colors hover:bg-muted ${
                  root !== "blueprint" ? "text-foreground" : ""
                }`}
                title="Plan against live/dev"
              >
                live/dev
              </button>
              <span className="text-border">|</span>
              <button
                type="button"
                onClick={() => onRootChange("blueprint")}
                className={`px-1.5 h-5 rounded-sm transition-colors hover:bg-muted ${
                  root === "blueprint" ? "text-foreground" : ""
                }`}
                title="Plan against live/blueprint (canvas workspace)"
              >
                blueprint
              </button>
              <span className="text-border">·</span>
            </>
          )}
          {root === "blueprint" && onLeafChange && (
            <>
              <select
                value={leaf ?? ""}
                onChange={(e) => onLeafChange(e.target.value || null)}
                className="text-[10px] font-mono rounded-sm border border-border bg-background px-1.5 h-6 outline-none focus:border-accent"
                title="Preview a single staged leaf"
              >
                <option value="">whole blueprint</option>
                {(leaves ?? []).map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
              <span className="text-border">·</span>
            </>
          )}
          <button
            type="button"
            className="px-1.5 h-5 rounded-sm transition-colors hover:bg-muted"
            onClick={allCollapsed ? expandAll : collapseAll}
            disabled={moduleGroups.length === 0}
          >
            {allCollapsed ? "expand all" : "collapse all"}
          </button>
          <span className="text-border">·</span>
          <button
            type="button"
            className="px-1.5 h-5 rounded-sm transition-colors hover:bg-muted"
            onClick={onRunPlan}
            disabled={loading}
          >
            {loading ? "…" : "run plan"}
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {error && (
          <div className="m-3 text-xs rounded-sm border border-red-200 dark:border-red-900 px-3 py-2 text-red-600 dark:text-red-400 whitespace-pre-wrap font-mono">
            {error}
          </div>
        )}
        {!error && !loading && diff && diff.visible_changes === 0 && (
          <p className="m-3 text-xs text-muted-foreground">
            No pending changes. The current state matches the configured HCL.
          </p>
        )}
        {!error &&
          moduleGroups.map((g) => (
            <ModuleSection
              key={g.module}
              moduleName={g.module}
              changes={g.changes}
              collapsed={collapsedModules.has(g.module)}
              expanded={expanded}
              focusAddress={focusAddress}
              onToggleModule={() => toggleModule(g.module)}
              onToggleRow={toggleRow}
            />
          ))}
      </div>
    </div>
  );
}

function ModuleSection({
  moduleName,
  changes,
  collapsed,
  expanded,
  focusAddress,
  onToggleModule,
  onToggleRow,
}: {
  moduleName: string;
  changes: ResourceChange[];
  collapsed: boolean;
  expanded: Set<string>;
  focusAddress?: string | null;
  onToggleModule: () => void;
  onToggleRow: (addr: string) => void;
}) {
  const totals = useMemo(() => {
    const t: Partial<Record<string, number>> = {};
    for (const c of changes) {
      t[c.action_kind] = (t[c.action_kind] ?? 0) + 1;
    }
    return t;
  }, [changes]);

  return (
    <div className="border-b border-border last:border-b-0">
      <header
        className="sticky top-0 z-10 flex items-center gap-2 px-3 h-7 bg-muted border-b border-border cursor-pointer select-none"
        onClick={onToggleModule}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="9"
          height="9"
          viewBox="0 0 10 10"
          fill="none"
          className={`text-muted-foreground transition-transform ${collapsed ? "" : "rotate-90"}`}
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
        <span className="font-mono text-[11px] text-foreground">{moduleName}</span>
        <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
          {changes.length}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {Object.entries(totals).map(([kind, n]) => {
            const meta = metaFor(kind);
            return (
              <span
                key={kind}
                className={`inline-flex items-center gap-0.5 px-1 h-[16px] rounded-sm ring-1 ring-inset font-mono text-[10px] ${meta.className}`}
              >
                <span>{meta.glyph}</span>
                <span className="tabular-nums">{n}</span>
              </span>
            );
          })}
        </div>
      </header>

      {!collapsed && (
        <div>
          {changes.map((c) => (
            <ChangeRow
              key={c.address}
              change={c}
              expanded={expanded.has(c.address) || focusAddress === c.address}
              onToggle={() => onToggleRow(c.address)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ChangeRow({
  change,
  expanded,
  onToggle,
}: {
  change: ResourceChange;
  expanded: boolean;
  onToggle: () => void;
}) {
  const meta = metaFor(change.action_kind);
  const leafChanges = useMemo(
    () => expandChanges(change.before, change.after),
    [change],
  );
  const attrCounts = useMemo(() => countAttrChanges(change), [change]);

  const inner = change.module
    ? change.address.slice(change.module.length + 1)
    : change.address;
  const lastDot = inner.lastIndexOf(".");
  const typeText = lastDot >= 0 ? inner.slice(0, lastDot + 1) : "";
  const nameText = lastDot >= 0 ? inner.slice(lastDot + 1) : inner;

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className={`w-full flex items-center gap-2 pl-3 pr-3 h-8 text-left cursor-pointer transition-colors relative ${
          expanded ? "bg-muted/40" : "hover:bg-muted/50"
        }`}
      >
        <span className={`absolute left-0 top-0 bottom-0 w-[2px] ${meta.rail}`} />
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="9"
          height="9"
          viewBox="0 0 10 10"
          fill="none"
          className={`text-muted-foreground ml-1 transition-transform ${expanded ? "rotate-90" : ""}`}
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
        <span
          className={`inline-flex items-center justify-center w-4 h-4 font-mono text-[11px] font-medium ${actionGlyphTextColor(change.action_kind)}`}
        >
          {meta.glyph}
        </span>
        <span
          className="font-mono text-xs text-foreground truncate min-w-0 flex-1"
          title={change.address}
        >
          <span className="text-muted-foreground">{typeText}</span>
          <span className="font-medium">{nameText}</span>
        </span>

        {meta.forcesNew && (
          <span className="text-[10px] font-mono px-1.5 h-[16px] inline-flex items-center rounded-sm ring-1 ring-inset ring-red-200 bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300 dark:ring-red-900">
            forces new
          </span>
        )}
        <span className="inline-flex items-center gap-1 font-mono text-[10px]">
          {attrCounts.added > 0 && (
            <AttrPill kind="create" glyph="+" n={attrCounts.added} />
          )}
          {attrCounts.changed > 0 && (
            <AttrPill kind="update" glyph="~" n={attrCounts.changed} />
          )}
          {attrCounts.removed > 0 && (
            <AttrPill kind="delete" glyph="-" n={attrCounts.removed} />
          )}
        </span>
      </button>

      {expanded && (
        <div className="px-10 py-2 bg-muted/30 border-t border-border">
          {leafChanges.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic">
              {change.action_kind === "import"
                ? "Pure import. No attribute changes."
                : "No leaf-level attribute changes detected."}
            </p>
          ) : (
            <TreeDiff leafChanges={leafChanges} />
          )}
        </div>
      )}
    </div>
  );
}

function AttrPill({
  kind,
  glyph,
  n,
}: {
  kind: ActionKind;
  glyph: string;
  n: number;
}) {
  const meta = metaFor(kind);
  return (
    <span
      className={`inline-flex items-center gap-0.5 px-1 h-[16px] rounded-sm ring-1 ring-inset ${meta.className}`}
    >
      <span>{glyph}</span>
      <span className="tabular-nums">{n}</span>
    </span>
  );
}

function actionGlyphTextColor(kind: ActionKind): string {
  switch (kind) {
    case "create":
      return "text-emerald-700 dark:text-emerald-400";
    case "update":
      return "text-amber-700 dark:text-amber-400";
    case "delete":
    case "replace":
      return "text-red-600 dark:text-red-400";
    case "import":
    case "import_update":
      return "text-sky-700 dark:text-sky-400";
    default:
      return "text-muted-foreground";
  }
}

function countAttrChanges(c: ResourceChange): {
  added: number;
  removed: number;
  changed: number;
} {
  const before = (c.before ?? {}) as Record<string, unknown>;
  const after = (c.after ?? {}) as Record<string, unknown>;
  let added = 0;
  let removed = 0;
  let changed = 0;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const hasB = k in before && before[k] !== null;
    const hasA = k in after && after[k] !== null;
    if (!hasB && hasA) added++;
    else if (hasB && !hasA) removed++;
    else if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changed++;
  }
  return { added, removed, changed };
}

function TreeDiff({
  leafChanges,
}: {
  leafChanges: ReturnType<typeof expandChanges>;
}) {
  const grouped = useMemo(() => {
    const byTop = new Map<string, typeof leafChanges>();
    for (const c of leafChanges) {
      const dot = c.path.indexOf(".");
      const top = dot >= 0 ? c.path.slice(0, dot) : c.path;
      if (!byTop.has(top)) byTop.set(top, [] as typeof leafChanges);
      byTop.get(top)!.push(c);
    }
    return [...byTop.entries()];
  }, [leafChanges]);

  return (
    <>
      {grouped.map(([top, items]) => {
        const isNested = items.some((c) => c.path.includes("."));
        if (!isNested) {
          const c = items[0]!;
          return (
            <div key={top} className="mb-2 last:mb-0 font-mono text-[11px]">
              <div className="flex items-center gap-1 text-muted-foreground flex-wrap">
                <span className="text-amber-700 dark:text-amber-400">~</span>
                <span className="text-foreground">{top}</span>
                <span className="text-muted-foreground">=</span>
                <DiffSpan before={c.before} after={c.after} />
              </div>
            </div>
          );
        }
        return (
          <div key={top} className="mb-2 last:mb-0 font-mono text-[11px]">
            <div className="flex items-center gap-1 text-muted-foreground">
              <span className="text-amber-700 dark:text-amber-400">~</span>
              <span className="text-foreground">{top}</span>
              <span className="text-muted-foreground">= {"{"}</span>
            </div>
            <div className="pl-4 border-l border-border ml-[5px] space-y-0.5">
              {items.map((c) => {
                const tail = c.path.slice(top.length + 1);
                return (
                  <div key={c.path} className="flex items-center gap-1 flex-wrap">
                    <span className="text-amber-700 dark:text-amber-400">~</span>
                    <span className="text-foreground">{tail}</span>
                    <span className="text-muted-foreground">=</span>
                    <DiffSpan before={c.before} after={c.after} />
                  </div>
                );
              })}
            </div>
            <div className="text-muted-foreground">{"}"}</div>
          </div>
        );
      })}
    </>
  );
}

function DiffSpan({ before, after }: { before: unknown; after: unknown }) {
  return (
    <span className="inline-flex items-center min-w-0">
      <span className="bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-200 px-1 py-0.5 border-l-2 border-red-300 dark:border-red-800 truncate max-w-[18ch]">
        {fmtValue(before)}
      </span>
      <span className="text-muted-foreground mx-1">→</span>
      <span className="bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-200 px-1 py-0.5 border-l-2 border-emerald-400 dark:border-emerald-800 truncate max-w-[18ch]">
        {fmtValue(after)}
      </span>
    </span>
  );
}
