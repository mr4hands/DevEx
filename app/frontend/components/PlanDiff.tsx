"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchPlanDiff } from "@/lib/api";
import type { ActionKind, PlanDiffResponse, ResourceChange } from "@/lib/types";

const ACTION_META: Record<
  string,
  { glyph: string; label: string; className: string }
> = {
  create: {
    glyph: "+",
    label: "create",
    className: "text-emerald-600 dark:text-emerald-400",
  },
  update: {
    glyph: "~",
    label: "update",
    className: "text-amber-600 dark:text-amber-400",
  },
  delete: {
    glyph: "-",
    label: "destroy",
    className: "text-red-600 dark:text-red-400",
  },
  replace: {
    glyph: "±",
    label: "replace",
    className: "text-orange-600 dark:text-orange-400",
  },
  import: {
    glyph: "→",
    label: "import",
    className: "text-sky-600 dark:text-sky-400",
  },
  import_update: {
    glyph: "→~",
    label: "import + update",
    className: "text-sky-600 dark:text-sky-400",
  },
  "no-op": {
    glyph: "·",
    label: "no-op",
    className: "text-muted-foreground",
  },
  read: {
    glyph: "?",
    label: "read",
    className: "text-muted-foreground",
  },
};

function metaFor(kind: ActionKind) {
  return (
    ACTION_META[kind] ?? {
      glyph: "?",
      label: kind,
      className: "text-muted-foreground",
    }
  );
}

/** Returns the keys whose JSON-serialized values differ between before/after.
 *  Cheap, correct enough for surface-level diff. Sensitive values appear as
 *  `null` in both before/after when masked by the provider; those keys won't
 *  show up unless they genuinely changed. */
function changedAttrs(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string[] {
  if (!before && !after) return [];
  const a = before ?? {};
  const b = after ?? {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    const av = JSON.stringify(a[k] ?? null);
    const bv = JSON.stringify(b[k] ?? null);
    if (av !== bv) out.push(k);
  }
  return out.sort();
}

export function PlanDiff({ refreshKey }: { refreshKey?: number }) {
  const [diff, setDiff] = useState<PlanDiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    // Cancel any in-flight request — plan runs are slow, multi-clicks shouldn't
    // queue them up.
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setLoading(true);
    setError(null);
    try {
      setDiff(await fetchPlanDiff(ac.signal));
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError((e as Error).message);
    } finally {
      if (abortRef.current === ac) {
        setLoading(false);
        abortRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => abortRef.current?.abort();
  }, [load, refreshKey]);

  const groups = useMemo(() => {
    if (!diff) return [] as { kind: string; items: ResourceChange[] }[];
    const buckets = new Map<string, ResourceChange[]>();
    // Preserve a deterministic visual order — most-impactful first.
    const order = [
      "delete",
      "replace",
      "create",
      "update",
      "import_update",
      "import",
      "no-op",
      "read",
    ];
    for (const c of diff.changes) {
      const k = c.action_kind;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k)!.push(c);
    }
    return order
      .map((k) => ({ kind: k, items: buckets.get(k) ?? [] }))
      .filter((g) => g.items.length > 0)
      .concat(
        [...buckets.entries()]
          .filter(([k]) => !order.includes(k))
          .map(([k, items]) => ({ kind: k, items })),
      );
  }, [diff]);

  const toggle = (addr: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(addr)) next.delete(addr);
      else next.add(addr);
      return next;
    });

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <div className="flex-1">
          <h2 className="text-sm font-semibold">Plan</h2>
          <p className="text-xs text-muted-foreground">
            {loading
              ? "Running tofu plan…"
              : diff
                ? summarize(diff)
                : "click Run plan to compute"}
          </p>
        </div>
        <button
          type="button"
          className="rounded border border-border bg-muted px-2 py-1 text-xs hover:border-accent disabled:opacity-50"
          onClick={load}
          disabled={loading}
        >
          {loading ? "…" : "Run plan"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="m-4 text-xs rounded border border-red-200 dark:border-red-900 px-3 py-2 text-red-600 dark:text-red-400 whitespace-pre-wrap font-mono">
            {error}
          </div>
        )}
        {!error && !loading && diff && diff.visible_changes === 0 && (
          <p className="m-4 text-sm text-muted-foreground">
            No pending changes. The current state matches the configured HCL.
          </p>
        )}
        {!error && groups.map((g) => {
          const meta = metaFor(g.kind);
          return (
            <section key={g.kind}>
              <header className="sticky top-0 bg-background/95 backdrop-blur px-4 py-1.5 text-[11px] font-mono uppercase tracking-wide border-b border-border flex items-center gap-2">
                <span className={`font-semibold ${meta.className}`}>
                  {meta.glyph}
                </span>
                <span className="text-muted-foreground">
                  {meta.label} · {g.items.length}
                </span>
              </header>
              <ul>
                {g.items.map((c) => {
                  const isOpen = expanded.has(c.address);
                  const changed = changedAttrs(c.before, c.after);
                  return (
                    <li key={c.address}>
                      <button
                        type="button"
                        onClick={() => toggle(c.address)}
                        className="w-full text-left px-4 py-2 text-sm border-b border-border hover:bg-muted transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <span className={`font-mono text-xs ${meta.className}`}>
                            {meta.glyph}
                          </span>
                          <span className="font-mono text-xs truncate flex-1">
                            {c.address}
                          </span>
                        </div>
                        <div className="ml-5 text-[11px] text-muted-foreground truncate">
                          {c.importing_id && (
                            <>
                              id=<span className="font-mono">{c.importing_id}</span>
                              {changed.length > 0 && " · "}
                            </>
                          )}
                          {changed.length > 0 && (
                            <>
                              {changed.length} attr
                              {changed.length === 1 ? "" : "s"} change
                              {changed.length === 1 ? "s" : ""}
                            </>
                          )}
                        </div>
                      </button>
                      {isOpen && <DiffBody change={c} changed={changed} />}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function summarize(diff: PlanDiffResponse): string {
  const ordered = ["create", "update", "delete", "replace", "import", "import_update"];
  const parts: string[] = [];
  for (const k of ordered) {
    const n = diff.counts[k] ?? 0;
    if (n > 0) parts.push(`${n} ${metaFor(k).label}`);
  }
  return parts.length > 0 ? parts.join(", ") : "no changes";
}

function DiffBody({
  change,
  changed,
}: {
  change: ResourceChange;
  changed: string[];
}) {
  return (
    <div className="px-4 py-2 bg-muted/40 border-b border-border text-xs space-y-1">
      {changed.length === 0 ? (
        <div className="text-muted-foreground italic">
          {change.action_kind === "import"
            ? "Pure import. No attribute changes."
            : "No attribute changes detected at this level."}
        </div>
      ) : (
        <table className="w-full font-mono">
          <tbody>
            {changed.map((k) => (
              <tr key={k}>
                <td className="py-0.5 pr-3 text-muted-foreground align-top whitespace-nowrap">
                  {k}
                </td>
                <td className="py-0.5 break-all">
                  <div className="text-red-600 dark:text-red-400">
                    {fmtValue(change.before?.[k])}
                  </div>
                  <div className="text-emerald-600 dark:text-emerald-400">
                    {fmtValue(change.after?.[k])}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function fmtValue(v: unknown): string {
  if (v === undefined) return "(unset)";
  if (v === null) return "null";
  if (typeof v === "string") return v.length > 200 ? v.slice(0, 200) + "…" : v;
  try {
    const s = JSON.stringify(v);
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
  } catch {
    return String(v);
  }
}
