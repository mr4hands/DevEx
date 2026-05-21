"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  deleteBlueprintResource,
  fetchSchemas,
  generateBlueprintConfig,
  writeBlueprintResource,
} from "@/lib/api";
import { FAMILY_CLASSES, familyOf } from "@/lib/resourceFamilies";
import type { BlueprintNode } from "@/components/BlueprintCanvas";
import type {
  BlueprintBlockInstance,
  ResourceAttribute,
  ResourceBlockType,
  ResourceSchema,
} from "@/lib/types";

/**
 * Right-pane drawer for the Blueprint canvas — shown when the middle
 * pane is in `blueprint` mode. Empty state when no node is selected.
 *
 * Phase 2 (this PR): renders a schema-driven attribute form. Name +
 * required attributes are surfaced first; the full list lives behind a
 * "show all" toggle with a search filter. Save → POST → file lands in
 * `live/blueprint/resources/<type>.<name>.tf`.
 *
 * Form values live in component state keyed by node id, so toggling
 * between nodes doesn't lose unsaved edits. Schemas are cached in a
 * module-level Map so re-selecting a type doesn't refetch.
 *
 * Phase 3 will close the loop: re-read the workspace's HCL on tab
 * focus so external edits + AI agent writes flow back into the canvas.
 */

const schemaCache = new Map<string, ResourceSchema>();

type FormValues = Record<string, unknown>;
type FormBlocks = Record<string, BlueprintBlockInstance[]>;
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
   *  another resource's node and selects it. The parent maps
   *  `<type>.<name>` → canvas node and pans React Flow into view. */
  onNavigateToRef?: (targetAddress: string) => void;
}) {
  const [schema, setSchema] = useState<ResourceSchema | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-node form state. The outer map key is the node id; inner is
  // `{name, attrs, blocks}`. Survives across node toggles.
  const [valuesByNode, setValuesByNode] = useState<
    Record<string, { name: string; attrs: FormValues; blocks: FormBlocks }>
  >({});
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" });

  const nodeKey = node?.id ?? null;
  const formState = useMemo(() => {
    if (!node || !nodeKey) return null;
    const existing = valuesByNode[nodeKey];
    if (existing) return existing;
    // First selection of this node — seed the form from whatever the
    // server already knows about it (Phase 3 round-trip). For fresh
    // canvas drops, `attributes`/`blocks` are undefined and the form
    // starts empty.
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
    // Parse-error nodes have no usable schema. Skip the fetch so we
    // don't make a broken `/api/schemas` call; the drawer renders the
    // error banner + Delete button instead of the form.
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
          [nodeKey]: {
            ...current,
            attrs: { ...current.attrs, [attr]: value },
          },
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
        return {
          ...prev,
          [nodeKey]: { ...current, blocks: next },
        };
      });
    },
    [nodeKey, node],
  );

  const handleSave = useCallback(async () => {
    if (!node || !formState || !schema) return;
    setSaveState({ status: "saving" });
    try {
      // Only persist editable schema attributes. Imported/generated
      // resources seed the form from disk, which can include AWS-filled
      // values (id, tags_all, arn, …) that aren't editable fields —
      // writing those back into HCL would be wrong, so drop anything not
      // in the schema. Also strip undefined / empty-string values.
      const editableNames = new Set(schema.attributes.map((a) => a.name));
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
    // Only saved resources have a file to delete. For brand-new canvas
    // drops, just clear the node from the canvas locally.
    const hasFile =
      node.data.attributes !== undefined ||
      // Backwards-compatible heuristic: nodes that were loaded from
      // server-side state have id == "<type>.<name>" (no random suffix).
      node.id === `${node.data.resourceType}.${node.data.name}`;
    setSaveState({ status: "saving" });
    try {
      if (hasFile) {
        await deleteBlueprintResource(
          node.data.resourceType,
          node.data.name,
        );
      }
      setSaveState({ status: "idle" });
      onResourceDeleted?.(node.id);
    } catch (e) {
      setSaveState({ status: "error", message: (e as Error).message });
    }
  }, [node, onResourceDeleted]);

  const requiredAttrs = useMemo(
    () => schema?.attributes.filter((a) => a.required) ?? [],
    [schema],
  );
  const optionalAttrs = useMemo(
    () => schema?.attributes.filter((a) => !a.required && !a.deprecated) ?? [],
    [schema],
  );
  const filteredOptional = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return optionalAttrs;
    return optionalAttrs.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q),
    );
  }, [optionalAttrs, search]);

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
                {node.data.filename ?? `${node.data.resourceType}.${node.data.name}.tf`}
              </span>
              . Edit the file by hand, or delete the resource and re-create it from the palette.
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
          <>
            {/* Name */}
            <section>
              <FieldRow
                label="name"
                description="HCL block label — also the file name on disk."
                required
              >
                <input
                  className="w-full text-xs font-mono rounded-sm border border-border bg-background px-2 py-1 outline-none focus:border-accent"
                  value={formState.name}
                  onChange={(e) => setFieldName(e.target.value)}
                  pattern="[a-zA-Z_][a-zA-Z0-9_]*"
                  placeholder="logs"
                />
              </FieldRow>
            </section>

            {/* Required */}
            {requiredAttrs.length > 0 && (
              <section>
                <SectionHeader title="Required" count={requiredAttrs.length} />
                <div className="mt-1.5 space-y-2">
                  {requiredAttrs.map((a) => (
                    <AttrInput
                      key={a.name}
                      attr={a}
                      value={formState.attrs[a.name]}
                      onChange={(v) => setAttr(a.name, v)}
                      onNavigateToRef={onNavigateToRef}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Optional (collapsed by default) */}
            {optionalAttrs.length > 0 && (
              <section>
                <button
                  type="button"
                  onClick={() => setShowAll((v) => !v)}
                  className="w-full flex items-center justify-between text-left"
                >
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Optional{" "}
                    <span className="font-mono text-muted-foreground/80">
                      ({optionalAttrs.length})
                    </span>
                  </span>
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {showAll ? "hide" : "show"}
                  </span>
                </button>
                {showAll && (
                  <div className="mt-1.5 space-y-2">
                    <input
                      className="w-full text-xs rounded-sm border border-border bg-background px-2 py-1 outline-none focus:border-accent placeholder:text-muted-foreground/70"
                      placeholder="filter optional attributes…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    {filteredOptional.length === 0 ? (
                      <p className="text-muted-foreground text-[11px] italic">
                        No matches.
                      </p>
                    ) : (
                      filteredOptional.map((a) => (
                        <AttrInput
                          key={a.name}
                          attr={a}
                          value={formState.attrs[a.name]}
                          onChange={(v) => setAttr(a.name, v)}
                          onNavigateToRef={onNavigateToRef}
                        />
                      ))
                    )}
                  </div>
                )}
              </section>
            )}

            {schema.block_types.length > 0 && (
              <section className="border-t border-border pt-3 space-y-2">
                <SectionHeader
                  title="Nested blocks"
                  count={schema.block_types.length}
                />
                {schema.block_types.map((bt) => (
                  <BlockEditor
                    key={bt.name}
                    blockType={bt}
                    instances={formState.blocks[bt.name] ?? []}
                    onChange={(next) =>
                      setBlocks({ ...formState.blocks, [bt.name]: next })
                    }
                    onNavigateToRef={onNavigateToRef}
                  />
                ))}
              </section>
            )}
          </>
        )}
      </div>

      {/* Footer — Save + Delete (Save hidden on parse-error nodes
          since there's no form state to write). */}
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

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {title}
      </span>
      <span className="text-[10px] font-mono text-muted-foreground/80">
        ({count})
      </span>
    </div>
  );
}

function FieldRow({
  label,
  description,
  required,
  computed,
  children,
}: {
  label: string;
  description?: string;
  required?: boolean;
  /** Optional-computed: editable, but AWS fills it if left blank. */
  computed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-1.5 mb-1">
        <label className="text-[10px] uppercase tracking-wide text-foreground font-mono">
          {label}
        </label>
        {required && (
          <span className="text-[9px] font-mono text-amber-700 dark:text-amber-400">
            req
          </span>
        )}
        {computed && !required && (
          <span
            title="AWS fills this in if you leave it blank"
            className="text-[9px] font-mono text-sky-600 dark:text-sky-400"
          >
            auto
          </span>
        )}
      </div>
      {children}
      {description && (
        <p className="mt-0.5 text-[10px] text-muted-foreground leading-snug">
          {description}
        </p>
      )}
    </div>
  );
}

/** When an attribute's string value looks like a reference to another
 *  canvas resource (`aws_x.y.z`, possibly wrapped in `${...}`),
 *  returns the target address `aws_x.y`. Used to render the eye-icon
 *  navigator alongside reference fields. Mirrors the backend's
 *  `_REF_PREFIX_RE` so the UI and writer agree on what counts. */
const _REF_NAV_RE =
  /^(aws_[a-z][a-z0-9_]+)\.([a-zA-Z_][a-zA-Z0-9_]*)(?:\.|$)/;

function parseReferenceTarget(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let v = value.trim();
  if (v.startsWith("${") && v.endsWith("}")) v = v.slice(2, -1).trim();
  const m = _REF_NAV_RE.exec(v);
  return m ? `${m[1]}.${m[2]}` : null;
}

function AttrInput({
  attr,
  value,
  onChange,
  onNavigateToRef,
}: {
  attr: ResourceAttribute;
  value: unknown;
  onChange: (v: unknown) => void;
  /** When set, reference-shaped string values render with an eye icon
   *  that jumps the canvas to the referenced node. Lifted via the
   *  drawer's prop chain from `page.tsx`. */
  onNavigateToRef?: (targetAddress: string) => void;
}) {
  const kind = attrKind(attr.type);
  const refTarget = parseReferenceTarget(value);
  return (
    <FieldRow
      label={attr.name}
      description={
        attr.description ||
        (attr.sensitive ? "sensitive — values are stored in plain HCL" : "")
      }
      required={attr.required}
      computed={attr.computed}
    >
      <div className="flex items-stretch gap-1">
        {kind === "bool" && (
          <select
            className="text-xs font-mono rounded-sm border border-border bg-background px-2 py-1 outline-none focus:border-accent"
            value={String(value ?? "")}
            onChange={(e) => {
              const v = e.target.value;
              onChange(v === "" ? undefined : v === "true");
            }}
          >
            <option value="">(unset)</option>
            <option value="false">false</option>
            <option value="true">true</option>
          </select>
        )}
        {kind === "number" && (
          <input
            type="number"
            className="w-full text-xs font-mono rounded-sm border border-border bg-background px-2 py-1 outline-none focus:border-accent"
            value={value === undefined || value === null ? "" : String(value)}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "") onChange(undefined);
              else {
                const n = Number(raw);
                onChange(Number.isNaN(n) ? raw : n);
              }
            }}
            placeholder={attr.required ? "" : "(unset)"}
          />
        )}
        {kind === "complex" && (
          <textarea
            className="w-full text-[11px] font-mono rounded-sm border border-border bg-background px-2 py-1 outline-none focus:border-accent resize-y min-h-[44px]"
            value={
              value === undefined || value === null
                ? ""
                : typeof value === "string"
                  ? value
                  : JSON.stringify(value)
            }
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "") {
                onChange(undefined);
                return;
              }
              try {
                onChange(JSON.parse(raw));
              } catch {
                onChange(raw);
              }
            }}
            placeholder='JSON, e.g. ["a","b"] or {"k":"v"}'
          />
        )}
        {kind === "string" && (
          <input
            type={attr.sensitive ? "password" : "text"}
            className="w-full text-xs font-mono rounded-sm border border-border bg-background px-2 py-1 outline-none focus:border-accent placeholder:text-muted-foreground/70"
            value={value === undefined || value === null ? "" : String(value)}
            onChange={(e) => {
              const raw = e.target.value;
              onChange(raw === "" ? undefined : raw);
            }}
            placeholder={attr.required ? "" : "(unset)"}
          />
        )}
        {refTarget && onNavigateToRef && (
          <button
            type="button"
            onClick={() => onNavigateToRef(refTarget)}
            aria-label={`Open ${refTarget} on the canvas`}
            title={`Open ${refTarget} on the canvas`}
            className="shrink-0 inline-flex items-center justify-center w-7 px-1 border border-border bg-background hover:bg-muted hover:border-accent text-muted-foreground hover:text-foreground rounded-sm transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="12"
              height="12"
              viewBox="0 0 14 14"
              fill="none"
            >
              <path
                d="M1 7s2-4 6-4 6 4 6 4-2 4-6 4-6-4-6-4z"
                stroke="currentColor"
                strokeWidth="1.2"
                fill="none"
              />
              <circle
                cx="7"
                cy="7"
                r="1.7"
                stroke="currentColor"
                strokeWidth="1.2"
                fill="none"
              />
            </svg>
          </button>
        )}
      </div>
    </FieldRow>
  );
}

/** Coarse classifier on the provider-schema `type` field so we can
 *  pick the right input element. The provider returns types like
 *  `"string"`, `"number"`, `"bool"`, `["list","string"]`,
 *  `["map","string"]`, `["set",[...]]`, `["object",{...}]`. */
function attrKind(type: unknown): "string" | "number" | "bool" | "complex" {
  if (type === "string") return "string";
  if (type === "number") return "number";
  if (type === "bool") return "bool";
  // Anything nested (list/set/map/object/tuple) goes through the
  // JSON textarea for v1.
  return "complex";
}

/**
 * Recursive editor for one nested block type (`versioning`, `ingress`,
 * `lifecycle_rule`, etc.). Renders the schema's attribute form per
 * instance + a recursive `BlockEditor` for each of the block type's
 * own `block_types`, so e.g., `lifecycle_rule → transition → ...`
 * editable all the way down.
 *
 * Nesting mode handling:
 *   - `single` — at most one instance. Renders "Add" only when empty.
 *   - `list` / `set` — N instances. "Add" appends; per-instance × removes.
 *   - `map` — not supported in Phase 4. Few of our 5 MVP types use it.
 *
 * Empty instances (no attrs, no nested blocks) still survive — they
 * render as `versioning {}` on disk, matching what `tofu fmt` produces
 * for "configured-but-no-args" blocks.
 */
function BlockEditor({
  blockType,
  instances,
  onChange,
  depth = 0,
  onNavigateToRef,
}: {
  blockType: ResourceBlockType;
  instances: BlueprintBlockInstance[];
  onChange: (next: BlueprintBlockInstance[]) => void;
  depth?: number;
  onNavigateToRef?: (targetAddress: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const canAdd =
    instances.length === 0 ||
    blockType.nesting_mode === "list" ||
    blockType.nesting_mode === "set";
  const maxItems =
    blockType.max_items > 0 ? blockType.max_items : Number.POSITIVE_INFINITY;
  const atMax = instances.length >= maxItems;

  const addInstance = () =>
    onChange([...instances, { attributes: {}, blocks: {} }]);
  const removeAt = (idx: number) =>
    onChange(instances.filter((_, i) => i !== idx));
  const updateAt = (idx: number, patch: Partial<BlueprintBlockInstance>) =>
    onChange(
      instances.map((it, i) => (i === idx ? { ...it, ...patch } : it)),
    );

  return (
    <div className="rounded-sm border border-border bg-muted/30">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center gap-2 px-2 h-7 text-left hover:bg-muted/60"
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
        <span className="text-[11px] font-mono text-foreground">
          {blockType.name}
        </span>
        <span className="text-[10px] font-mono text-muted-foreground">
          {instances.length > 0 ? `× ${instances.length}` : "empty"}
        </span>
        <span className="ml-auto text-[10px] font-mono text-muted-foreground">
          {blockType.nesting_mode}
        </span>
      </button>
      {!collapsed && (
        <div className="px-2 pb-2 space-y-2">
          {instances.map((inst, i) => (
            <BlockInstanceEditor
              key={i}
              instance={inst}
              blockType={blockType}
              depth={depth}
              onUpdate={(patch) => updateAt(i, patch)}
              onRemove={() => removeAt(i)}
              instanceIndex={i}
              isOnlyInstance={instances.length === 1}
              onNavigateToRef={onNavigateToRef}
            />
          ))}
          {canAdd && !atMax && (
            <button
              type="button"
              onClick={addInstance}
              className="w-full text-[10px] font-mono text-muted-foreground hover:text-foreground border border-dashed border-border rounded-sm h-7"
            >
              + add {blockType.name}
            </button>
          )}
          {blockType.truncated && (
            <p className="text-[10px] text-muted-foreground italic">
              Deeper nesting exists but isn&apos;t surfaced (schema cap).
              Edit via chat or directly in the .tf file.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function BlockInstanceEditor({
  instance,
  blockType,
  depth,
  onUpdate,
  onRemove,
  instanceIndex,
  isOnlyInstance,
  onNavigateToRef,
}: {
  instance: BlueprintBlockInstance;
  blockType: ResourceBlockType;
  depth: number;
  onUpdate: (patch: Partial<BlueprintBlockInstance>) => void;
  onRemove: () => void;
  instanceIndex: number;
  isOnlyInstance: boolean;
  onNavigateToRef?: (targetAddress: string) => void;
}) {
  const setAttr = (name: string, value: unknown) =>
    onUpdate({ attributes: { ...instance.attributes, [name]: value } });
  const setNestedBlocks = (
    nestedName: string,
    next: BlueprintBlockInstance[],
  ) =>
    onUpdate({ blocks: { ...instance.blocks, [nestedName]: next } });

  const requiredAttrs = blockType.attributes.filter((a) => a.required);
  const optionalAttrs = blockType.attributes.filter(
    (a) => !a.required && !a.deprecated,
  );

  return (
    <div className="rounded-sm border border-border bg-background p-2">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-mono text-muted-foreground">
          {blockType.name}
          {!isOnlyInstance && (blockType.nesting_mode === "list" || blockType.nesting_mode === "set")
            ? ` [${instanceIndex}]`
            : ""}
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove block instance"
          title="Remove"
          className="shrink-0 inline-flex items-center justify-center w-4 h-4 text-muted-foreground hover:text-red-600 dark:hover:text-red-400 rounded-sm"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 12 12" fill="none">
            <path
              d="M2.5 2.5l7 7M9.5 2.5l-7 7"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      <div className="space-y-1.5">
        {requiredAttrs.map((a) => (
          <AttrInput
            key={a.name}
            attr={a}
            value={instance.attributes[a.name]}
            onChange={(v) => setAttr(a.name, v)}
            onNavigateToRef={onNavigateToRef}
          />
        ))}
        {optionalAttrs.map((a) => (
          <AttrInput
            key={a.name}
            attr={a}
            value={instance.attributes[a.name]}
            onChange={(v) => setAttr(a.name, v)}
            onNavigateToRef={onNavigateToRef}
          />
        ))}
      </div>
      {blockType.block_types.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {blockType.block_types.map((bt) => (
            <BlockEditor
              key={bt.name}
              blockType={bt}
              instances={instance.blocks[bt.name] ?? []}
              onChange={(next) => setNestedBlocks(bt.name, next)}
              depth={depth + 1}
              onNavigateToRef={onNavigateToRef}
            />
          ))}
        </div>
      )}
    </div>
  );
}
