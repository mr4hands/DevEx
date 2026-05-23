"use client";

import { useCallback, useMemo, useState } from "react";

import { discardDraft, fetchSchemas, writeDraft } from "@/lib/api";
import {
  ResourceDrawer,
  type ChangeSummary,
} from "@/components/ResourceDrawer";
import { ResourceForm, type FormBlocks } from "@/components/ResourceForm";
import { fmtValue } from "@/lib/resourceFields";
import type { InventoryResource, LeafCoords, Resource, ResourceSchema } from "@/lib/types";

/**
 * Unified right-pane inspector for a tree-selected resource. View mode
 * reuses `ResourceDrawer`; clicking Edit (or "Adopt & edit" for unmanaged)
 * fetches the schema, seeds an editable form from the resource's current
 * values, shows a diff vs live, and saves the change as an owner-scoped
 * draft via the Phase-1 draft API. Managed → `edit` draft, unmanaged →
 * `adopt` draft (with the import id).
 *
 * Decision: managed resources with no draft are PARKED — Edit/Delete
 * buttons are hidden because there's no leaf path to write into. Draft
 * rows carry their own coords; unmanaged rows adopt into the active leaf.
 */
export function ResourceInspector({
  item,
  change,
  activeLeaf,
  onClose,
  onOpenInPlanDiff,
  onReassign,
  onChanged,
}: {
  item: InventoryResource;
  change?: ChangeSummary | null;
  /** The current authoring leaf. Adopt targets this; null disables adopt. */
  activeLeaf: LeafCoords | null;
  onClose: () => void;
  onOpenInPlanDiff?: (r: Resource) => void;
  onReassign?: (address: string, component: string) => Promise<void> | void;
  /** Fired after a draft is saved/discarded so the parent refreshes. */
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [schema, setSchema] = useState<ResourceSchema | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attrs, setAttrs] = useState<Record<string, unknown>>({});
  const [blocks, setBlocks] = useState<FormBlocks>({});
  const [saveState, setSaveState] = useState<
    { status: "idle" | "saving" } | { status: "error"; message: string }
  >({ status: "idle" });

  const isUnmanaged = item.state === "unmanaged";

  const resource: Resource = useMemo(
    () => ({
      address: item.address,
      type: item.type,
      name: item.name,
      module: "",
      mode: item.managed ? "managed" : "unmanaged",
      provider: "",
      values: item.values,
    }),
    [item],
  );

  // A draft row carries its leaf coords; adopting an unmanaged row uses the
  // active leaf. Managed rows with no draft have no leaf → null (parked).
  const draftCoords: LeafCoords | null = useMemo(() => {
    if (item.draft_kind) {
      return {
        account: item.account,
        region: item.region,
        layer: item.layer,
        component: item.component ?? "",
      };
    }
    if (isUnmanaged) return activeLeaf;
    return null;
  }, [item, isUnmanaged, activeLeaf]);

  const enterEdit = useCallback(() => {
    setEditing(true);
    setSaveState({ status: "idle" });
    setAttrs({ ...(item.values as Record<string, unknown>) });
    setBlocks({});
    setLoading(true);
    setError(null);
    fetchSchemas([item.type])
      .then((res) => setSchema(res.resources[item.type] ?? null))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [item]);

  const setAttr = useCallback((name: string, value: unknown) => {
    setAttrs((prev) => ({ ...prev, [name]: value }));
  }, []);

  const diffs = useMemo(() => {
    if (!schema) return [];
    const editable = new Set(
      schema.attributes.filter((a) => !a.read_only).map((a) => a.name),
    );
    const live = item.values as Record<string, unknown>;
    const out: { name: string; before: unknown; after: unknown }[] = [];
    for (const name of editable) {
      const before = live[name];
      const after = attrs[name];
      if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) {
        out.push({ name, before, after });
      }
    }
    return out;
  }, [schema, attrs, item.values]);

  const save = useCallback(async () => {
    if (!schema || !draftCoords) return;
    setSaveState({ status: "saving" });
    try {
      const editable = new Set(
        schema.attributes.filter((a) => !a.read_only).map((a) => a.name),
      );
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(attrs)) {
        if (!editable.has(k)) continue;
        if (v === undefined || v === null) continue;
        if (typeof v === "string" && v.trim() === "") continue;
        clean[k] = v;
      }
      const existing = item.draft_kind;
      const kind: "new" | "adopt" | "edit" =
        existing === "new" || existing === "adopt" || existing === "edit"
          ? existing
          : isUnmanaged
            ? "adopt"
            : "edit";
      await writeDraft({
        kind,
        type: item.type,
        name: item.name,
        source_address: item.address,
        import_id: kind === "adopt" ? (item.id ?? undefined) : undefined,
        attributes: clean,
        ...draftCoords,
      });
      setEditing(false);
      onChanged();
    } catch (e) {
      setSaveState({ status: "error", message: (e as Error).message });
    }
  }, [schema, attrs, isUnmanaged, item, onChanged, draftCoords]);

  const discard = useCallback(async () => {
    try {
      if (item.draft_kind && draftCoords) {
        await discardDraft(item.type, item.name, draftCoords);
        onChanged();
      }
    } finally {
      setEditing(false);
    }
  }, [item, onChanged, draftCoords]);

  const hasDraft = !!item.draft_kind;
  // Park managed edit/delete (no leaf path). Draft rows can be discarded;
  // unmanaged rows can be adopted into the active leaf.
  const canDelete = hasDraft && !!draftCoords;
  const deleteResource = useCallback(async () => {
    if (hasDraft && draftCoords) {
      await discardDraft(item.type, item.name, draftCoords);
      onChanged();
    }
  }, [hasDraft, item, onChanged, draftCoords]);

  if (!editing) {
    // Managed rows with no draft are parked (no leaf path). Drafts edit in
    // place; unmanaged rows adopt into the active leaf (needs one selected).
    const canEdit = hasDraft || (isUnmanaged && !!activeLeaf);
    return (
      <ResourceDrawer
        resource={resource}
        change={change}
        onClose={onClose}
        onOpenInPlanDiff={onOpenInPlanDiff}
        component={item.component}
        onReassign={onReassign}
        onEdit={canEdit ? enterEdit : undefined}
        editLabel={isUnmanaged ? "Adopt & edit" : "Edit"}
        onDelete={canDelete ? () => void deleteResource() : undefined}
        deleteLabel="Discard draft"
      />
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-background">
      {/* Header */}
      <div className="shrink-0 border-b border-border px-3 pt-3 pb-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-[10px] font-mono text-muted-foreground">
              {item.type}
            </span>
            <span className="text-border text-[10px]">·</span>
            <span className="inline-flex items-center px-1.5 h-[18px] text-[10px] font-mono rounded-sm ring-1 ring-inset ring-amber-300 dark:ring-amber-800 text-amber-800 dark:text-amber-300">
              {isUnmanaged ? "adopting → draft" : "editing → draft"}
            </span>
          </div>
          <div className="font-mono text-sm leading-snug text-foreground break-all">
            {item.address}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setEditing(false)}
          aria-label="Cancel edit"
          className="shrink-0 h-6 px-2 inline-flex items-center justify-center text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted rounded-sm transition-colors"
        >
          cancel
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-3 text-xs">
        {loading && <p className="text-muted-foreground">Loading schema…</p>}
        {error && (
          <div className="rounded-sm border border-red-200 dark:border-red-900 px-3 py-2 text-red-600 dark:text-red-400 whitespace-pre-wrap font-mono">
            {error}
          </div>
        )}

        {diffs.length > 0 && (
          <div className="rounded-sm border border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/30 px-2 py-2">
            <div className="text-[10px] uppercase tracking-wide text-amber-800 dark:text-amber-300 mb-1">
              Pending change vs live ({diffs.length})
            </div>
            <div className="space-y-1.5">
              {diffs.map((d) => (
                <div key={d.name} className="font-mono text-[11px]">
                  <div className="text-muted-foreground break-all">{d.name}</div>
                  <div className="flex">
                    <span className="w-3 shrink-0 text-red-600 dark:text-red-400">
                      −
                    </span>
                    <span className="flex-1 break-all text-red-900 dark:text-red-200">
                      {fmtValue(d.before)}
                    </span>
                  </div>
                  <div className="flex">
                    <span className="w-3 shrink-0 text-emerald-600 dark:text-emerald-400">
                      +
                    </span>
                    <span className="flex-1 break-all text-emerald-900 dark:text-emerald-200">
                      {fmtValue(d.after)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {schema && (
          <ResourceForm
            schema={schema}
            name={item.name}
            nameEditable={false}
            attrs={attrs}
            blocks={blocks}
            observed={item.values as Record<string, unknown>}
            onNameChange={() => {}}
            onAttr={setAttr}
            onBlocks={setBlocks}
          />
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-border px-3 py-2.5 bg-muted/40 space-y-2">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saveState.status === "saving" || !schema}
            className="flex-1 inline-flex items-center justify-center h-8 px-3 bg-accent hover:opacity-90 text-white text-xs font-medium rounded-sm transition-colors disabled:opacity-50"
          >
            {saveState.status === "saving" ? "Saving…" : "Save draft"}
          </button>
          <button
            type="button"
            onClick={discard}
            title={
              item.draft_kind
                ? "Discard the saved draft for this resource"
                : "Discard unsaved edits"
            }
            className="inline-flex items-center justify-center h-8 px-3 border border-border hover:bg-muted hover:border-red-300 dark:hover:border-red-800 text-xs text-foreground rounded-sm transition-colors"
          >
            Discard
          </button>
        </div>
        {saveState.status === "error" && (
          <div className="text-[10px] font-mono text-red-600 dark:text-red-400 break-all whitespace-pre-wrap">
            ✗ {saveState.message}
          </div>
        )}
      </div>
    </div>
  );
}
