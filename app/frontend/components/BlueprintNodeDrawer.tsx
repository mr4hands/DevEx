"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  deleteBlueprintResource,
  fetchSchemas,
  writeBlueprintResource,
} from "@/lib/api";
import { FAMILY_CLASSES, familyOf } from "@/lib/resourceFamilies";
import type { BlueprintNode } from "@/components/BlueprintCanvas";
import type { ResourceAttribute, ResourceSchema } from "@/lib/types";

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
}) {
  const [schema, setSchema] = useState<ResourceSchema | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-node form state. The outer map key is the node id; inner is
  // the attribute name → value. Survives across node toggles.
  const [valuesByNode, setValuesByNode] = useState<
    Record<string, { name: string; attrs: FormValues }>
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
    // canvas drops, `attributes` is undefined and the form starts
    // empty.
    return {
      name: node.data.name,
      attrs: (node.data.attributes as Record<string, unknown>) ?? {},
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
        },
      }));
    },
    [nodeKey],
  );

  const setAttr = useCallback(
    (attr: string, value: unknown) => {
      if (!nodeKey) return;
      setValuesByNode((prev) => {
        const current = prev[nodeKey] ?? { name: node!.data.name, attrs: {} };
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

  const handleSave = useCallback(async () => {
    if (!node || !formState || !schema) return;
    setSaveState({ status: "saving" });
    try {
      // Strip undefined / empty-string values — the backend filters
      // them anyway, but we'd rather not POST a payload full of nulls.
      const cleanAttrs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(formState.attrs)) {
        if (v === undefined || v === null) continue;
        if (typeof v === "string" && v.trim() === "") continue;
        cleanAttrs[k] = v;
      }
      const res = await writeBlueprintResource({
        type: node.data.resourceType,
        name: formState.name,
        attributes: cleanAttrs,
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
                        />
                      ))
                    )}
                  </div>
                )}
              </section>
            )}

            {schema.block_types.length > 0 && (
              <section className="border-t border-border pt-3">
                <SectionHeader
                  title="Nested blocks"
                  count={schema.block_types.length}
                />
                <p className="mt-1 text-[11px] text-muted-foreground italic">
                  Nested blocks ({schema.block_types
                    .slice(0, 3)
                    .map((b) => b.name)
                    .join(", ")}
                  {schema.block_types.length > 3
                    ? `, +${schema.block_types.length - 3} more`
                    : ""}
                  ) aren&apos;t editable in Phase 2 — coming in Phase 3.
                </p>
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
  children,
}: {
  label: string;
  description?: string;
  required?: boolean;
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

function AttrInput({
  attr,
  value,
  onChange,
}: {
  attr: ResourceAttribute;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const kind = attrKind(attr.type);
  return (
    <FieldRow
      label={attr.name}
      description={
        attr.description ||
        (attr.sensitive ? "sensitive — values are stored in plain HCL" : "")
      }
      required={attr.required}
    >
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
            // Try JSON-parse for collection types; fall back to raw
            // string so the user can type partial HCL while typing.
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
