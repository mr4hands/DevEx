"use client";

import { useMemo, useState } from "react";

import type {
  BlueprintBlockInstance,
  ResourceAttribute,
  ResourceBlockType,
  ResourceSchema,
} from "@/lib/types";

export type FormBlocks = Record<string, BlueprintBlockInstance[]>;

/**
 * Schema-driven attribute form, reused by the Blueprint node drawer and
 * the resource inspector. Renders the resource's name (optionally
 * editable), Required / Optional (search + collapse) / Set-by-AWS
 * (read-only) sections, and recursive nested-block editors. State for the
 * actual values lives in the parent; this component is presentational +
 * local view state (search/collapse toggles).
 */
export function ResourceForm({
  schema,
  name,
  nameEditable,
  attrs,
  blocks,
  observed,
  onNameChange,
  onAttr,
  onBlocks,
  onNavigateToRef,
}: {
  schema: ResourceSchema;
  name: string;
  /** When false the name field renders disabled (live resources keep a
   *  fixed HCL label). */
  nameEditable: boolean;
  attrs: Record<string, unknown>;
  blocks: FormBlocks;
  /** Live AWS values for read-only fields (arn, region, …); falls back to
   *  the form `attrs` value, then "(known after apply)". */
  observed?: Record<string, unknown>;
  onNameChange: (value: string) => void;
  onAttr: (attr: string, value: unknown) => void;
  onBlocks: (next: FormBlocks) => void;
  onNavigateToRef?: (targetAddress: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [showComputed, setShowComputed] = useState(false);

  const requiredAttrs = useMemo(
    () => schema.attributes.filter((a) => a.required && !a.read_only),
    [schema],
  );
  const optionalAttrs = useMemo(
    () =>
      schema.attributes.filter(
        (a) => !a.required && !a.deprecated && !a.read_only,
      ),
    [schema],
  );
  const readOnlyAttrs = useMemo(
    () => schema.attributes.filter((a) => a.read_only),
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

  const obs = observed ?? {};

  return (
    <>
      {/* Name */}
      <section>
        <FieldRow
          label="name"
          description="HCL block label — also the file name on disk."
          required
        >
          <input
            className={`w-full text-xs font-mono rounded-sm border border-border bg-background px-2 py-1 outline-none focus:border-accent ${
              nameEditable ? "" : "opacity-60"
            }`}
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            disabled={!nameEditable}
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
                value={attrs[a.name]}
                onChange={(v) => onAttr(a.name, v)}
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
                    value={attrs[a.name]}
                    onChange={(v) => onAttr(a.name, v)}
                    onNavigateToRef={onNavigateToRef}
                  />
                ))
              )}
            </div>
          )}
        </section>
      )}

      {/* Set by AWS — read-only. */}
      {readOnlyAttrs.length > 0 && (
        <section>
          <button
            type="button"
            onClick={() => setShowComputed((v) => !v)}
            className="w-full flex items-center justify-between text-left"
          >
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Set by AWS{" "}
              <span className="font-mono text-muted-foreground/80">
                ({readOnlyAttrs.length})
              </span>
            </span>
            <span className="text-[10px] font-mono text-muted-foreground">
              {showComputed ? "hide" : "show"}
            </span>
          </button>
          {showComputed && (
            <div className="mt-1.5 space-y-2">
              {readOnlyAttrs.map((a) => (
                <ReadOnlyAttr
                  key={a.name}
                  attr={a}
                  value={obs[a.name] ?? attrs[a.name]}
                />
              ))}
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
              instances={blocks[bt.name] ?? []}
              onChange={(next) => onBlocks({ ...blocks, [bt.name]: next })}
              onNavigateToRef={onNavigateToRef}
            />
          ))}
        </section>
      )}
    </>
  );
}

export function SectionHeader({
  title,
  count,
}: {
  title: string;
  count: number;
}) {
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

export function FieldRow({
  label,
  description,
  required,
  computed,
  readOnly,
  children,
}: {
  label: string;
  description?: string;
  required?: boolean;
  /** Optional-computed: editable, but AWS fills it if left blank. */
  computed?: boolean;
  /** AWS-assigned: shown disabled, never written. */
  readOnly?: boolean;
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
        {readOnly && (
          <span
            title="Set by AWS — read-only"
            className="text-[9px] font-mono text-muted-foreground"
          >
            aws
          </span>
        )}
        {computed && !required && !readOnly && (
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
 *  canvas resource (`aws_x.y.z`, possibly wrapped in `${...}`), returns
 *  the target address `aws_x.y`. Mirrors the backend's `_REF_PREFIX_RE`. */
const _REF_NAV_RE = /^(aws_[a-z][a-z0-9_]+)\.([a-zA-Z_][a-zA-Z0-9_]*)(?:\.|$)/;

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

/** Renders an AWS-assigned (read-only) attribute: shows its current value
 *  disabled when known, else the Terraform-native "(known after apply)"
 *  placeholder. */
function ReadOnlyAttr({
  attr,
  value,
}: {
  attr: ResourceAttribute;
  value: unknown;
}) {
  const hasValue =
    value !== undefined &&
    value !== null &&
    !(typeof value === "string" && value.trim() === "");
  const display = hasValue
    ? typeof value === "object"
      ? JSON.stringify(value)
      : String(value)
    : "(known after apply)";
  return (
    <FieldRow label={attr.name} description={attr.description} readOnly>
      <div
        title={display}
        className={`w-full text-xs font-mono rounded-sm border border-dashed border-border bg-muted/40 px-2 py-1 truncate ${
          hasValue ? "text-muted-foreground" : "text-muted-foreground/60 italic"
        }`}
      >
        {display}
      </div>
    </FieldRow>
  );
}

/** Coarse classifier on the provider-schema `type` field. */
function attrKind(type: unknown): "string" | "number" | "bool" | "complex" {
  if (type === "string") return "string";
  if (type === "number") return "number";
  if (type === "bool") return "bool";
  return "complex";
}

/**
 * Recursive editor for one nested block type (`versioning`, `ingress`,
 * `lifecycle_rule`, …). Renders the schema's attribute form per instance +
 * a recursive `BlockEditor` for each nested block type.
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
    onChange(instances.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

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
              Deeper nesting exists but isn&apos;t surfaced (schema cap). Edit
              via chat or directly in the .tf file.
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
  ) => onUpdate({ blocks: { ...instance.blocks, [nestedName]: next } });

  const requiredAttrs = blockType.attributes.filter(
    (a) => a.required && !a.read_only,
  );
  const optionalAttrs = blockType.attributes.filter(
    (a) => !a.required && !a.deprecated && !a.read_only,
  );

  return (
    <div className="rounded-sm border border-border bg-background p-2">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-mono text-muted-foreground">
          {blockType.name}
          {!isOnlyInstance &&
          (blockType.nesting_mode === "list" ||
            blockType.nesting_mode === "set")
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
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="9"
            height="9"
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
