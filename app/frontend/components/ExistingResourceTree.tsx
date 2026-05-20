"use client";

import { useCallback, useEffect, useState, type DragEvent } from "react";

import { fetchExistingResources } from "@/lib/api";
import { FAMILY_CLASSES, familyOf } from "@/lib/resourceFamilies";
import type { ExistingResource, ExistingResourceGroup } from "@/lib/types";

/** MIME used for dragging an existing (discovered) resource onto the
 *  canvas. Distinct from the palette drag type so the canvas can tell an
 *  adopt-drop from a fresh-drop. */
export const EXISTING_DRAG_TYPE = "application/devex-existing";

export function ExistingResourceTree({
  reloadKey,
  onDiscover,
}: {
  /** Bumped after a discovery tool-result so the tree refetches. */
  reloadKey?: number;
  /** Asks the parent to seed an agent discovery run for a scope
   *  ("all" or a resource type). */
  onDiscover: (scope: string) => void;
}) {
  const [groups, setGroups] = useState<ExistingResourceGroup[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const res = await fetchExistingResources(signal);
      setGroups(res.groups);
      setGeneratedAt(res.generated_at);
      setHint(res.hint ?? null);
      setError(res.error ?? null);
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
  }, [load, reloadKey]);

  return (
    <aside className="w-[200px] shrink-0 border-r border-border bg-muted/20 flex flex-col min-h-0">
      <div className="px-3 h-8 border-b border-border flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          existing (aws)
        </span>
        <button
          type="button"
          onClick={() => onDiscover("all")}
          disabled={loading}
          title="Ask the agent to discover AWS resources"
          className="px-1.5 h-5 text-[10px] font-mono rounded-sm border border-border bg-background hover:bg-muted transition-colors disabled:opacity-50"
        >
          {loading ? "…" : "discover"}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        {error && (
          <p className="m-2 text-[10px] text-red-600 dark:text-red-400 break-words">
            {error}
          </p>
        )}
        {!error && groups.length === 0 && (
          <p className="m-2 text-[10px] text-muted-foreground leading-relaxed">
            {hint ?? "No discovered resources yet."}
          </p>
        )}
        {groups.map((g) => (
          <TreeGroup key={g.type} group={g} onDiscover={onDiscover} />
        ))}
      </div>
      {generatedAt && (
        <div className="shrink-0 border-t border-border px-2 h-6 flex items-center text-[9px] font-mono text-muted-foreground">
          discovered {new Date(generatedAt).toLocaleTimeString()}
        </div>
      )}
    </aside>
  );
}

function TreeGroup({
  group,
  onDiscover,
}: {
  group: ExistingResourceGroup;
  onDiscover: (scope: string) => void;
}) {
  const meta = familyOf(group.type);
  const classes = FAMILY_CLASSES[meta.family];
  return (
    <section>
      <header className="flex items-center gap-1.5 px-2 h-6 bg-background/80 border-b border-border">
        <span
          className={`inline-flex items-center justify-center px-1 h-[16px] min-w-[22px] rounded-sm ring-1 ring-inset font-mono text-[9px] uppercase ${classes.chip}`}
        >
          {meta.monogram}
        </span>
        <span className="font-mono text-[10px] text-foreground truncate">
          {group.type}
        </span>
        <button
          type="button"
          onClick={() => onDiscover(group.type)}
          title="Re-discover this type"
          className="ml-auto text-[9px] font-mono text-muted-foreground hover:text-foreground"
        >
          ↻
        </button>
      </header>
      <ul>
        {group.resources.map((r) => (
          <TreeRow key={r.address} resource={r} railClass={classes.rail} />
        ))}
      </ul>
    </section>
  );
}

function TreeRow({
  resource,
  railClass,
}: {
  resource: ExistingResource;
  railClass: string;
}) {
  const onDragStart = useCallback(
    (e: DragEvent<HTMLLIElement>) => {
      e.dataTransfer.setData(EXISTING_DRAG_TYPE, JSON.stringify(resource));
      e.dataTransfer.effectAllowed = "copy";
    },
    [resource],
  );
  return (
    <li
      draggable
      onDragStart={onDragStart}
      title={`Drag to adopt ${resource.address} (id: ${resource.import_id})`}
      className="relative flex items-center gap-1.5 pl-4 pr-2 h-6 cursor-grab active:cursor-grabbing hover:bg-muted transition-colors border-b border-border"
    >
      <span className={`absolute left-1.5 top-1 bottom-1 w-[2px] ${railClass}`} />
      <span className="font-mono text-[10px] text-foreground truncate">
        {resource.name}
      </span>
    </li>
  );
}
