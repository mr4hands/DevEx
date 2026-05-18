"use client";

import { useMemo, useState } from "react";

import {
  ACTION_CHIP,
  expandChanges,
  fmtValue,
  identityFieldsFor,
} from "@/lib/resourceFields";
import type { Resource } from "@/lib/types";

/**
 * Minimal "this resource has a pending change" shape. Structural subset
 * of the full `ResourceChange` type that PR #11 (plan-diff) introduces.
 * Kept inline here so this drawer port doesn't depend on PR #11 landing
 * first — once #11 merges, the prop can be widened to the real type
 * in a follow-up.
 */
export type ChangeSummary = {
  action_kind: string; // "create" | "update" | "delete" | "replace" | "import" | "import_update" | ...
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

/**
 * Right-pane drawer for a selected resource.
 *
 * Variant B (diff-first): when a `change` prop is provided, pending
 * changes lead — current state is reference material below, mostly
 * collapsed. Optimizes for the common case (you opened the drawer
 * because of the diff).
 */
export function ResourceDrawer({
  resource,
  change,
  onClose,
  onOpenInPlanDiff,
}: {
  resource: Resource | null;
  /** Pending change for this resource, indexed by address by the parent
   *  from `/api/plan-diff`. Null when there's nothing pending or no
   *  plan has been run. */
  change?: ChangeSummary | null;
  onClose: () => void;
  /** Switch the middle pane to the Plan tab + auto-expand the row. */
  onOpenInPlanDiff?: (resource: Resource) => void;
}) {
  if (!resource) return <EmptyDrawer />;

  return (
    <DrawerBody
      resource={resource}
      change={change ?? null}
      onClose={onClose}
      onOpenInPlanDiff={onOpenInPlanDiff}
    />
  );
}

function EmptyDrawer() {
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold">Details</h2>
        <p className="text-xs text-muted-foreground">
          Click a resource to inspect it.
        </p>
      </div>
    </div>
  );
}

function DrawerBody({
  resource,
  change,
  onClose,
  onOpenInPlanDiff,
}: {
  resource: Resource;
  change: ChangeSummary | null;
  onClose: () => void;
  onOpenInPlanDiff?: (r: Resource) => void;
}) {
  const leafChanges = useMemo(
    () => (change ? expandChanges(change.before, change.after) : []),
    [change],
  );

  const identityFields = useMemo(() => identityFieldsFor(resource), [resource]);
  const tags = (resource.values.tags ?? {}) as Record<string, unknown>;
  const tagEntries = Object.entries(tags).filter(
    ([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
  ) as [string, string | number | boolean][];
  const changedTagKeys = useMemo(() => {
    return new Set(
      leafChanges
        .filter((c) => c.path.startsWith("tags."))
        .map((c) => c.path.slice("tags.".length)),
    );
  }, [leafChanges]);

  // Section open state. Identity, Tags, type-specific stay closed unless
  // they have changes that point at them; pending-changes is implicit
  // always-open at top.
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    identity: !change, // open when no pending change to bring attention to
    tags: false,
    typed: false,
    rest: false,
  });

  const toggle = (k: string) =>
    setOpenSections((p) => ({ ...p, [k]: !p[k] }));

  const actionChip =
    change && ACTION_CHIP[change.action_kind]
      ? ACTION_CHIP[change.action_kind]
      : null;

  // Type-specific section content (SG rules, etc.)
  const typedSection = useMemo(() => typedSectionFor(resource), [resource]);

  // "All other attributes" = values minus what we've shown above.
  const shownKeys = new Set<string>([
    "id",
    "arn",
    "tags",
    "tags_all",
    // identity-extras we already surfaced
    ...identityFields.map((f) => f.label.toLowerCase()),
    // Heuristic: type-specific section consumed these (best-effort)
    ...(typedSection?.consumedKeys ?? []),
  ]);
  const otherEntries = Object.entries(resource.values)
    .filter(([k]) => !shownKeys.has(k))
    .filter(([, v]) => v !== null && v !== undefined);

  return (
    <div className="flex flex-col h-full min-h-0 bg-background">
      {/* Header */}
      <div className="shrink-0 border-b border-border bg-background">
        <div className="px-3 pt-3 pb-2 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-[10px] font-mono text-muted-foreground">
                {resource.type}
              </span>
              {actionChip && (
                <>
                  <span className="text-border text-[10px]">·</span>
                  <span
                    className={`inline-flex items-center px-1.5 h-[18px] text-[10px] font-mono rounded-sm ring-1 ring-inset ${actionChip.classes}`}
                  >
                    {actionChip.glyph} {actionChip.label}
                  </span>
                </>
              )}
            </div>
            <AddressBreakdown address={resource.address} />
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

        {/* In-plan strip — clickable, deep-links to the Plan tab */}
        {change && leafChanges.length > 0 && (
          <button
            type="button"
            onClick={() => onOpenInPlanDiff?.(resource)}
            disabled={!onOpenInPlanDiff}
            className="w-full flex items-center gap-2 px-3 h-6 bg-amber-50 dark:bg-amber-950/40 border-t border-b border-amber-200 dark:border-amber-900 text-left hover:bg-amber-100/60 dark:hover:bg-amber-900/40 transition-colors disabled:cursor-default disabled:hover:bg-amber-50 dark:disabled:hover:bg-amber-950/40"
          >
            <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-amber-500 text-white text-[9px] font-mono leading-none">
              {leafChanges.length}
            </span>
            <span className="text-[11px] text-amber-900 dark:text-amber-200">
              in plan · {leafChanges.length} attribute
              {leafChanges.length === 1 ? "" : "s"} changing
            </span>
            {onOpenInPlanDiff && (
              <span className="text-[10px] text-amber-700/80 dark:text-amber-300/80 ml-auto font-mono">
                open in PlanDiff →
              </span>
            )}
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Pending changes — top, always expanded when present */}
        {change && leafChanges.length > 0 && (
          <PendingChangesSection
            changes={leafChanges}
            onOpenInPlanDiff={
              onOpenInPlanDiff ? () => onOpenInPlanDiff(resource) : undefined
            }
          />
        )}

        {/* Identity */}
        <CollapsibleSection
          title="Identity"
          count={`${identityFields.length} field${identityFields.length === 1 ? "" : "s"}`}
          open={openSections.identity}
          onToggle={() => toggle("identity")}
        >
          <div className="px-3 py-1.5 divide-y divide-border">
            {identityFields.map((f) => (
              <KvRow key={f.label} label={f.label} value={f.value} copyable={f.copyable} />
            ))}
            <KvRow label="Module" value={resource.module || "(root)"} />
          </div>
        </CollapsibleSection>

        {/* Tags */}
        {tagEntries.length > 0 && (
          <CollapsibleSection
            title="Tags"
            count={
              changedTagKeys.size > 0
                ? `${tagEntries.length} · ${changedTagKeys.size} changing`
                : `${tagEntries.length}`
            }
            open={openSections.tags}
            onToggle={() => toggle("tags")}
            highlight={changedTagKeys.size > 0}
          >
            <div className="px-3 py-2 flex flex-wrap gap-1">
              {tagEntries.map(([k, v]) => {
                const changed = changedTagKeys.has(k);
                return (
                  <span
                    key={k}
                    className={
                      "inline-flex items-center text-[11px] font-mono px-1.5 h-[20px] rounded-sm border " +
                      (changed
                        ? "border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200"
                        : "border-border bg-muted text-foreground")
                    }
                  >
                    <span className="text-muted-foreground">{k}</span>
                    <span className="text-muted-foreground mx-0.5">=</span>
                    <span>{String(v)}</span>
                    {changed && (
                      <span className="ml-1 text-[9px] text-amber-700 dark:text-amber-300">~</span>
                    )}
                  </span>
                );
              })}
            </div>
          </CollapsibleSection>
        )}

        {/* Type-specific */}
        {typedSection && (
          <CollapsibleSection
            title={typedSection.title}
            count={typedSection.count}
            open={openSections.typed}
            onToggle={() => toggle("typed")}
          >
            {typedSection.body}
          </CollapsibleSection>
        )}

        {/* All others */}
        <CollapsibleSection
          title="All other attributes"
          count={`${otherEntries.length} field${otherEntries.length === 1 ? "" : "s"}`}
          open={openSections.rest}
          onToggle={() => toggle("rest")}
          lastInList
        >
          <pre className="px-3 py-2 text-[11px] font-mono bg-muted/40 overflow-x-auto whitespace-pre-wrap break-words">
            {JSON.stringify(Object.fromEntries(otherEntries), null, 2)}
          </pre>
        </CollapsibleSection>
      </div>

      {/* Ambient-context footer hint */}
      <div className="shrink-0 border-t border-border px-3 py-2.5 bg-muted/50">
        <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
          <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-amber-500 text-white text-[9px] leading-none">
            1
          </span>
          <span>this resource is the chat&apos;s current context</span>
        </div>
      </div>
    </div>
  );
}

function AddressBreakdown({ address }: { address: string }) {
  // Split into "module.foo.bar." prefix + final resource label.
  // e.g. "module.web.aws_security_group.app" → "module.web.aws_security_group." + "app"
  const lastDot = address.lastIndexOf(".");
  const prefix = lastDot >= 0 ? address.slice(0, lastDot + 1) : "";
  const leaf = lastDot >= 0 ? address.slice(lastDot + 1) : address;

  return (
    <div className="font-mono text-sm leading-snug text-foreground break-all">
      {prefix && <span className="text-muted-foreground">{prefix}</span>}
      <span className="font-medium">{leaf}</span>
    </div>
  );
}

function PendingChangesSection({
  changes,
  onOpenInPlanDiff,
}: {
  changes: ReturnType<typeof expandChanges>;
  onOpenInPlanDiff?: () => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between px-3 h-7 border-b border-border bg-muted/40">
        <span className="text-[10px] uppercase tracking-[0.08em] font-medium text-muted-foreground">
          Pending changes
        </span>
        {onOpenInPlanDiff && (
          <button
            type="button"
            onClick={onOpenInPlanDiff}
            className="text-[10px] font-mono text-muted-foreground hover:text-foreground transition-colors"
          >
            open in plan diff →
          </button>
        )}
      </div>
      <div className="px-3 py-2 space-y-1.5">
        {changes.map((c) => (
          <div key={c.path} className="font-mono text-[11px]">
            <div className="text-muted-foreground mb-0.5 break-all">{c.path}</div>
            <div className="flex">
              <span className="w-3 shrink-0 text-red-600 dark:text-red-400">−</span>
              <span className="flex-1 bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-200 px-1.5 py-0.5 border-l-2 border-red-300 dark:border-red-800 break-all">
                {fmtValue(c.before)}
              </span>
            </div>
            <div className="flex mt-0.5">
              <span className="w-3 shrink-0 text-emerald-600 dark:text-emerald-400">+</span>
              <span className="flex-1 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-200 px-1.5 py-0.5 border-l-2 border-emerald-400 dark:border-emerald-800 break-all">
                {fmtValue(c.after)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function CollapsibleSection({
  title,
  count,
  open,
  highlight,
  lastInList,
  onToggle,
  children,
}: {
  title: string;
  count?: string;
  open: boolean;
  highlight?: boolean;
  lastInList?: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        className={`w-full flex items-center justify-between px-3 h-8 border-b text-left transition-colors hover:bg-muted/60 ${
          highlight ? "bg-amber-50/40 dark:bg-amber-950/20" : ""
        } ${lastInList ? "border-b-0" : "border-border"} ${
          lastInList ? "" : "border-border"
        }`}
      >
        <div className="flex items-center gap-2">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="9"
            height="9"
            viewBox="0 0 10 10"
            fill="none"
            className={`text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
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
          <span className="text-[11px] text-foreground font-medium">{title}</span>
          {count && (
            <span className="text-[10px] font-mono text-muted-foreground">{count}</span>
          )}
        </div>
      </button>
      {open && (
        <div className={lastInList ? "" : "border-b border-border"}>{children}</div>
      )}
    </>
  );
}

function KvRow({
  label,
  value,
  copyable,
}: {
  label: string;
  value: string;
  copyable?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2 py-1.5 group">
      <span className="w-14 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span
        className="flex-1 min-w-0 truncate text-xs text-foreground font-mono"
        title={value}
      >
        {value}
      </span>
      {copyable && <CopyButton value={value} />}
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label="Copy"
      title={copied ? "Copied!" : "Copy"}
      className="shrink-0 inline-flex items-center justify-center border border-border text-muted-foreground hover:text-foreground hover:bg-background transition-colors h-4 w-4 rounded-sm"
    >
      {copied ? (
        <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 12 12" fill="none">
          <path
            d="M2 6.5l2.5 2.5L10 3"
            stroke="currentColor"
            strokeWidth="1.4"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 12 12" fill="none">
          <rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.1" />
          <path d="M2 8V2.5A.5.5 0 0 1 2.5 2H8" stroke="currentColor" strokeWidth="1.1" />
        </svg>
      )}
    </button>
  );
}

/** Type-specific extras the drawer surfaces below Identity + Tags. */
function typedSectionFor(
  r: Resource,
): { title: string; count?: string; body: React.ReactNode; consumedKeys: string[] } | null {
  if (
    r.type === "aws_security_group" ||
    r.type === "aws_default_security_group"
  ) {
    const ingress = asRules(r.values.ingress);
    const egress = asRules(r.values.egress);
    return {
      title: "Rules",
      count: `${ingress.length} in · ${egress.length} out`,
      consumedKeys: ["ingress", "egress"],
      body: (
        <div className="px-3 py-2 space-y-2">
          {ingress.length > 0 && <RulesList kind="Ingress" rules={ingress} />}
          {egress.length > 0 && <RulesList kind="Egress" rules={egress} />}
          {ingress.length === 0 && egress.length === 0 && (
            <p className="text-[11px] text-muted-foreground">No rules.</p>
          )}
        </div>
      ),
    };
  }
  return null;
}

type Rule = {
  protocol?: unknown;
  from_port?: unknown;
  to_port?: unknown;
  cidr_blocks?: unknown;
  description?: unknown;
};

function asRules(v: unknown): Rule[] {
  return Array.isArray(v) ? (v as Rule[]) : [];
}

function RulesList({ kind, rules }: { kind: string; rules: Rule[] }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
        {kind}
      </div>
      <ul className="space-y-1">
        {rules.map((r, i) => (
          <li
            key={i}
            className="rounded-sm border border-border bg-muted/40 px-2 py-1 text-[11px] font-mono"
          >
            <div className="text-foreground">
              {String(r.protocol ?? "?")} {String(r.from_port ?? "?")}–
              {String(r.to_port ?? "?")}
            </div>
            {Array.isArray(r.cidr_blocks) && (
              <div className="text-muted-foreground">
                {(r.cidr_blocks as string[]).join(", ")}
              </div>
            )}
            {typeof r.description === "string" && r.description.length > 0 && (
              <div className="text-muted-foreground">
                {String(r.description)}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
