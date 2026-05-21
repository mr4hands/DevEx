"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  deleteBlueprintResource,
  fetchExistingResources,
  fetchSchemas,
  generateBlueprintConfig,
  writeBlueprintResource,
} from "@/lib/api";
import { FAMILY_CLASSES, familyOf } from "@/lib/resourceFamilies";
import type { BlueprintNode } from "@/components/BlueprintCanvas";
import { ResourceForm, type FormBlocks } from "@/components/ResourceForm";
import type { ResourceSchema } from "@/lib/types";

/**
 * Right-pane drawer for the Blueprint canvas. Renders the schema-driven
 * attribute form (via the shared `ResourceForm`) plus node-specific
 * header/footer, save/delete, and the adopted-resource strip.
 *
 * Form values live in component state keyed by node id, so toggling
 * between nodes doesn't lose unsaved edits. Schemas are cached in a
 * module-level Map so re-selecting a type doesn't refetch.
 */

const schemaCache = new Map<string, ResourceSchema>();

type FormValues = Record<string, unknown>;
type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; path: string }
  | { status: "error"; message: string };

export function BlueprintNodeDrawer({
  node,
  onClose,
  onRename,
  onResourceWritten,
  onResourceDeleted,
  onNavigateToRef,
}: {
  node: BlueprintNode | null;
  onClose: () => void;
  /** Fired when Save succeeds with a new name so the canvas can update
   *  the node's label without a full reload. */
  onRename?: (nodeId: string, newName: string) => void;
  /** Fired after a successful Save or Delete so the parent can bump
   *  the canvas's `reloadKey` and re-fetch from disk. */
  onResourceWritten?: () => void;
  onResourceDeleted?: (nodeId: string) => void;
  /** Click handler for the reference-eye icon: jumps the canvas to
   *  another resource's node and selects it. */
  onNavigateToRef?: (targetAddress: string) => void;
}) {
  const [schema, setSchema] = useState<ResourceSchema | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Live AWS values for an adopted resource's read-only fields, sourced
  // from the discovery manifest (not the config HCL, which never holds
  // computed values). `id` always comes from the import id we adopted with.
  const [observed, setObserved] = useState<Record<string, unknown>>({});

  // Per-node form state keyed by node id; survives across node toggles.
  const [valuesByNode, setValuesByNode] = useState<
    Record<string, { name: string; attrs: FormValues; blocks: FormBlocks }>
  >({});
  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" });

  const nodeKey = node?.id ?? null;
  const formState = useMemo(() => {
    if (!node || !nodeKey) return null;
    const existing = valuesByNode[nodeKey];
    if (existing) return existing;
    return {
      name: node.data.name,
      attrs: (node.data.attributes as Record<string, unknown>) ?? {},
      blocks: node.data.blocks ?? {},
    };
  }, [node, nodeKey, valuesByNode]);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!node) {
      setSchema(null);
      setSaveState({ status: "idle" });
      return;
    }
    setSaveState({ status: "idle" });
    if (node.data.parseError) {
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

  // For adopted resources, pull the live AWS values from the discovery
  // manifest so the read-only section shows real values. Display-only.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!node || !(node.data.imported || node.data.importId)) {
      setObserved({});
      return;
    }
    const base: Record<string, unknown> = node.data.importId
      ? { id: node.data.importId }
      : {};
    setObserved(base);
    let cancelled = false;
    const ac = new AbortController();
    const type = node.data.resourceType;
    const name = node.data.name;
    fetchExistingResources(ac.signal, type)
      .then((res) => {
        if (cancelled) return;
        const match = res.groups
          .flatMap((g) => g.resources)
          .find((r) => r.type === type && r.name === name);
        setObserved(match ? { ...match.summary_attributes, ...base } : base);
      })
      .catch(() => {
        /* manifest unavailable — keep base (id only) */
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [node]);

  const setFieldName = useCallback(
    (value: string) => {
      if (!nodeKey) return;
      setValuesByNode((prev) => ({
        ...prev,
        [nodeKey]: {
          name: value,
          attrs: prev[nodeKey]?.attrs ?? {},
          blocks: prev[nodeKey]?.blocks ?? {},
        },
      }));
    },
    [nodeKey],
  );

  const setAttr = useCallback(
    (attr: string, value: unknown) => {
      if (!nodeKey) return;
      setValuesByNode((prev) => {
        const current = prev[nodeKey] ?? {
          name: node!.data.name,
          attrs: {},
          blocks: {},
        };
        return {
          ...prev,
          [nodeKey]: { ...current, attrs: { ...current.attrs, [attr]: value } },
        };
      });
    },
    [nodeKey, node],
  );

  const setBlocks = useCallback(
    (next: FormBlocks) => {
      if (!nodeKey) return;
      setValuesByNode((prev) => {
        const current = prev[nodeKey] ?? {
          name: node!.data.name,
          attrs: {},
          blocks: {},
        };
        return { ...prev, [nodeKey]: { ...current, blocks: next } };
      });
    },
    [nodeKey, node],
  );

  const handleSave = useCallback(async () => {
    if (!node || !formState || !schema) return;
    setSaveState({ status: "saving" });
    try {
      // Only persist editable schema attributes. Imported/generated
      // resources seed the form from disk, which can include AWS-assigned
      // values (id, tags_all, arn, …) — drop anything read-only. Also
      // strip undefined / empty-string values.
      const editableNames = new Set(
        schema.attributes.filter((a) => !a.read_only).map((a) => a.name),
      );
      const cleanAttrs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(formState.attrs)) {
        if (!editableNames.has(k)) continue;
        if (v === undefined || v === null) continue;
        if (typeof v === "string" && v.trim() === "") continue;
        cleanAttrs[k] = v;
      }
      const res = await writeBlueprintResource({
        type: node.data.resourceType,
        name: formState.name,
        attributes: cleanAttrs,
        blocks: formState.blocks,
        position: node.position
          ? { x: node.position.x, y: node.position.y }
          : null,
      });
      setSaveState({ status: "saved", path: res.path });
      if (onRename && formState.name !== node.data.name) {
        onRename(node.id, formState.name);
      }
      onResourceWritten?.();
    } catch (e) {
      setSaveState({ status: "error", message: (e as Error).message });
    }
  }, [node, formState, schema, onRename, onResourceWritten]);

  const handleDelete = useCallback(async () => {
    if (!node) return;
    const hasFile =
      node.data.attributes !== undefined ||
      node.id === `${node.data.resourceType}.${node.data.name}`;
    setSaveState({ status: "saving" });
    try {
      if (hasFile) {
        await deleteBlueprintResource(node.data.resourceType, node.data.name);
      }
      setSaveState({ status: "idle" });
      onResourceDeleted?.(node.id);
    } catch (e) {
      setSaveState({ status: "error", message: (e as Error).message });
    }
  }, [node, onResourceDeleted]);

  if (!node) return <EmptyDrawer />;

  const meta = familyOf(node.data.resourceType);
  const classes = FAMILY_CLASSES[meta.family];

  return (
    <div className="flex flex-col h-full min-h-0 bg-background">
      {/* Header */}
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
              <span className="font-medium">
                {formState?.name ?? node.data.name}
              </span>
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

      {/* Body */}
      <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-3 text-xs">
        {(node.data.imported || node.data.importId) && (
          <AdoptedStrip
            type={node.data.resourceType}
            name={node.data.name}
            importId={node.data.importId ?? null}
            onGenerated={onResourceWritten}
          />
        )}
        {loading && <p className="text-muted-foreground">Loading schema…</p>}
        {node.data.parseError && (
          <section className="space-y-2">
            <h3 className="text-[10px] uppercase tracking-wide text-red-700 dark:text-red-400">
              File can&apos;t be parsed
            </h3>
            <p className="text-[11px] text-muted-foreground">
              The backend couldn&apos;t parse{" "}
              <span className="font-mono text-foreground">
                {node.data.filename ??
                  `${node.data.resourceType}.${node.data.name}.tf`}
              </span>
              . Edit the file by hand, or delete the resource and re-create it
              from the palette.
            </p>
            <pre className="text-[10.5px] font-mono bg-muted/40 border border-red-200 dark:border-red-900 px-2 py-1.5 rounded-sm text-red-700 dark:text-red-400 overflow-x-auto whitespace-pre-wrap break-words">
              {node.data.parseError}
            </pre>
          </section>
        )}
        {error && (
          <div className="rounded-sm border border-red-200 dark:border-red-900 px-3 py-2 text-red-600 dark:text-red-400 whitespace-pre-wrap font-mono">
            {error}
          </div>
        )}
        {!node.data.parseError && schema && formState && (
          <ResourceForm
            schema={schema}
            name={formState.name}
            nameEditable
            attrs={formState.attrs}
            blocks={formState.blocks}
            observed={observed}
            onNameChange={setFieldName}
            onAttr={setAttr}
            onBlocks={setBlocks}
            onNavigateToRef={onNavigateToRef}
          />
        )}
      </div>

      {/* Footer — Save + Delete */}
      {(schema && formState) || node.data.parseError ? (
        <div className="shrink-0 border-t border-border px-3 py-2.5 bg-muted/40 space-y-2">
          <div className="flex gap-2">
            {!node.data.parseError && schema && formState && (
              <button
                type="button"
                onClick={handleSave}
                disabled={
                  saveState.status === "saving" || !formState.name.trim()
                }
                className="flex-1 inline-flex items-center justify-center gap-2 h-8 px-3 bg-accent hover:opacity-90 text-white text-xs font-medium rounded-sm transition-colors disabled:opacity-50"
              >
                {saveState.status === "saving" ? "Saving…" : "Save resource"}
              </button>
            )}
            <button
              type="button"
              onClick={handleDelete}
              disabled={saveState.status === "saving"}
              title="Remove resource (deletes the .tf file if it was saved)"
              className={
                "inline-flex items-center justify-center h-8 px-3 border border-border hover:bg-muted hover:border-red-300 dark:hover:border-red-800 text-xs text-foreground rounded-sm transition-colors disabled:opacity-50 " +
                (node.data.parseError ? "flex-1" : "")
              }
            >
              {node.data.parseError ? "Delete broken file" : "Delete"}
            </button>
          </div>
          {saveState.status === "saved" && (
            <div className="text-[10px] font-mono text-emerald-700 dark:text-emerald-400 break-all">
              ✓ wrote {saveState.path}
            </div>
          )}
          {saveState.status === "error" && (
            <div className="text-[10px] font-mono text-red-600 dark:text-red-400 break-all whitespace-pre-wrap">
              ✗ {saveState.message}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function EmptyDrawer() {
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

/** Strip shown above the form for adopted (imported) nodes: surfaces the
 *  real cloud id and a button that swaps the thin pre-fill body for
 *  apply-clean HCL via generate-config-out. */
function AdoptedStrip({
  type,
  name,
  importId,
  onGenerated,
}: {
  type: string;
  name: string;
  importId: string | null;
  onGenerated?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onGenerate = async () => {
    setBusy(true);
    setErr(null);
    try {
      await generateBlueprintConfig(type, name);
      onGenerated?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-sm border border-sky-200 dark:border-sky-900 bg-sky-50/60 dark:bg-sky-950/30 px-2 py-2">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center px-1 h-[15px] rounded-sm ring-1 ring-inset ring-sky-400/50 text-sky-700 dark:text-sky-300 font-mono text-[8px] uppercase tracking-wide">
          imported
        </span>
        <span
          className="font-mono text-[10px] text-muted-foreground truncate"
          title={importId ?? ""}
        >
          id: {importId ?? "(unknown)"}
        </span>
        <button
          type="button"
          onClick={onGenerate}
          disabled={busy}
          title="Replace the thin pre-fill with apply-clean HCL via generate-config-out"
          className="ml-auto px-1.5 h-6 text-[10px] font-mono rounded-sm border border-border bg-background hover:bg-muted transition-colors disabled:opacity-50"
        >
          {busy ? "generating…" : "generate clean config"}
        </button>
      </div>
      {err && (
        <p className="mt-1 text-[10px] text-red-600 dark:text-red-400 break-words">
          {err}
        </p>
      )}
    </div>
  );
}
