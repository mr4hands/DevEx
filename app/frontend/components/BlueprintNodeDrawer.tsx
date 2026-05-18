"use client";

import { useEffect, useState } from "react";

import { fetchSchemas } from "@/lib/api";
import { FAMILY_CLASSES, familyOf } from "@/lib/resourceFamilies";
import type { BlueprintNode } from "@/components/BlueprintCanvas";
import type { ResourceSchema } from "@/lib/types";

/**
 * Right-pane drawer for the Blueprint canvas — shown when the middle
 * pane is in `blueprint` mode. Empty state when no node is selected.
 *
 * Phase 1 (this PR): renders the node identity (type, name, family
 * chip) and lists what `/api/schemas` advertises for that type
 * (required + optional attribute count, block-type count). No form
 * yet — that's Phase 2.
 *
 * The schema fetch is cached per type per session in a module-level
 * Map so dragging multiple nodes of the same type doesn't refetch.
 */

const schemaCache = new Map<string, ResourceSchema>();

export function BlueprintNodeDrawer({
  node,
  onClose,
}: {
  node: BlueprintNode | null;
  onClose: () => void;
}) {
  const [schema, setSchema] = useState<ResourceSchema | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Selection changed — sync schema state from cache or kick off a
    // fetch. The lint rule flags any setState inside an effect; here
    // it's the canonical "sync external selection into a local cache"
    // pattern, which the rule docs list as a valid exception.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!node) {
      setSchema(null);
      return;
    }
    const type = node.data.resourceType;
    const cached = schemaCache.get(type);
    if (cached) {
      setSchema(cached);
      return;
    }
    let cancelled = false;
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    fetchSchemas([type], ac.signal)
      .then((res) => {
        if (cancelled) return;
        const s = res.resources[type] ?? null;
        if (s) schemaCache.set(type, s);
        setSchema(s);
      })
      .catch((e: Error) => {
        if (cancelled || e.name === "AbortError") return;
        setError(e.message);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [node]);

  if (!node) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Blueprint node</h2>
          <p className="text-xs text-muted-foreground">
            Drag a resource onto the canvas, then click it to edit.
          </p>
        </div>
      </div>
    );
  }

  const meta = familyOf(node.data.resourceType);
  const classes = FAMILY_CLASSES[meta.family];
  const requiredAttrs = schema?.attributes.filter((a) => a.required) ?? [];
  const optionalAttrs = schema?.attributes.filter((a) => !a.required) ?? [];

  return (
    <div className="flex flex-col h-full min-h-0 bg-background">
      <div className="shrink-0 border-b border-border">
        <div className="px-3 pt-3 pb-2 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 mb-1">
              <span
                className={`inline-flex items-center justify-center px-1.5 h-[18px] min-w-[28px] rounded-sm ring-1 ring-inset font-mono text-[10px] uppercase ${classes.chip}`}
              >
                {meta.monogram}
              </span>
              <span className="text-[10px] font-mono text-muted-foreground">
                {node.data.resourceType}
              </span>
              <span className="text-border text-[10px]">·</span>
              <span className="text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-400">
                blueprint
              </span>
            </div>
            <div className="font-mono text-sm leading-snug text-foreground break-all">
              <span className="text-muted-foreground">
                {node.data.resourceType}.
              </span>
              <span className="font-medium">{node.data.name}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 h-6 w-6 inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted rounded-sm transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="11"
              height="11"
              viewBox="0 0 12 12"
              fill="none"
            >
              <path
                d="M2.5 2.5l7 7M9.5 2.5l-7 7"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-3 text-xs">
        {loading && (
          <p className="text-muted-foreground">Loading schema…</p>
        )}
        {error && (
          <div className="rounded-sm border border-red-200 dark:border-red-900 px-3 py-2 text-red-600 dark:text-red-400 whitespace-pre-wrap font-mono">
            {error}
          </div>
        )}
        {schema && (
          <>
            <section>
              <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
                Identity
              </h3>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
                <dt className="text-muted-foreground">type</dt>
                <dd className="text-foreground break-all">
                  {node.data.resourceType}
                </dd>
                <dt className="text-muted-foreground">name</dt>
                <dd className="text-foreground break-all">{node.data.name}</dd>
                <dt className="text-muted-foreground">id</dt>
                <dd className="text-muted-foreground text-[10px] break-all">
                  {node.id}
                </dd>
              </dl>
            </section>

            <section>
              <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
                Schema overview
              </h3>
              <ul className="space-y-1 font-mono text-[11px]">
                <li className="flex justify-between">
                  <span className="text-muted-foreground">required attrs</span>
                  <span className="text-foreground tabular-nums">
                    {requiredAttrs.length}
                  </span>
                </li>
                <li className="flex justify-between">
                  <span className="text-muted-foreground">optional attrs</span>
                  <span className="text-foreground tabular-nums">
                    {optionalAttrs.length}
                  </span>
                </li>
                <li className="flex justify-between">
                  <span className="text-muted-foreground">block types</span>
                  <span className="text-foreground tabular-nums">
                    {schema.block_types.length}
                  </span>
                </li>
              </ul>
            </section>

            {requiredAttrs.length > 0 && (
              <section>
                <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
                  Required ({requiredAttrs.length})
                </h3>
                <ul className="space-y-1 font-mono text-[11px]">
                  {requiredAttrs.slice(0, 8).map((a) => (
                    <li key={a.name} className="text-foreground">
                      {a.name}
                    </li>
                  ))}
                  {requiredAttrs.length > 8 && (
                    <li className="text-muted-foreground italic">
                      + {requiredAttrs.length - 8} more…
                    </li>
                  )}
                </ul>
              </section>
            )}

            <section className="border-t border-border pt-3">
              <p className="text-muted-foreground text-[11px] italic">
                Phase 2 will add the attribute form here. Today: drag,
                drop, inspect.
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
