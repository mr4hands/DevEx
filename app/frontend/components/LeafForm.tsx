// app/frontend/components/LeafForm.tsx
"use client";

import { useState } from "react";

import { COORD_RE } from "@/lib/api";
import type { LeafCoords } from "@/lib/types";

const FIELDS: { key: keyof LeafCoords; label: string; placeholder: string }[] = [
  { key: "account", label: "account", placeholder: "billing-prod-account" },
  { key: "region", label: "region", placeholder: "us-east-1" },
  { key: "layer", label: "layer", placeholder: "infra" },
  { key: "component", label: "component", placeholder: "net" },
];

/**
 * "New leaf" form. Collects the four devex-live coords, validates each to
 * the backend's lowercase/digit/hyphen rule, and hands them up. The parent
 * sets these as the active authoring leaf and opens QuickCreate for them.
 */
export function LeafForm({
  onCreate,
  onCancel,
  initial,
}: {
  onCreate: (coords: LeafCoords) => void;
  onCancel: () => void;
  initial?: Partial<LeafCoords>;
}) {
  const [coords, setCoords] = useState<LeafCoords>({
    account: initial?.account ?? "",
    region: initial?.region ?? "",
    layer: initial?.layer ?? "",
    component: initial?.component ?? "",
  });

  const allValid = FIELDS.every(({ key }) => COORD_RE.test(coords[key]));
  const set = (key: keyof LeafCoords, v: string) =>
    setCoords((prev) => ({ ...prev, [key]: v }));

  return (
    <div className="flex flex-col h-full min-h-0 bg-background">
      <div className="shrink-0 border-b border-border px-3 pt-3 pb-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
            New leaf
          </div>
          <div className="font-mono text-xs text-muted-foreground break-all">
            account / region / layer / component
          </div>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 h-6 px-2 inline-flex items-center justify-center text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted rounded-sm transition-colors"
        >
          cancel
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-3 text-xs">
        {FIELDS.map(({ key, label, placeholder }) => {
          const val = coords[key];
          const bad = val.length > 0 && !COORD_RE.test(val);
          return (
            <div key={key}>
              <label className="text-[10px] uppercase tracking-wide text-foreground font-mono">
                {label}
              </label>
              <input
                className="mt-1 w-full text-xs font-mono rounded-sm border border-border bg-background px-2 py-1 outline-none focus:border-accent"
                value={val}
                placeholder={placeholder}
                onChange={(e) => set(key, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && allValid) onCreate(coords);
                }}
              />
              {bad && (
                <p className="mt-0.5 text-[10px] text-red-600 dark:text-red-400">
                  lowercase letters, digits, hyphen; no spaces or dots.
                </p>
              )}
            </div>
          );
        })}
        <p className="text-[10px] text-muted-foreground">
          Creates a staged leaf shaped like a devex-live stack. The next
          resource you add lands here.
        </p>
      </div>

      <div className="shrink-0 border-t border-border px-3 py-2.5 bg-muted/40">
        <button
          type="button"
          onClick={() => onCreate(coords)}
          disabled={!allValid}
          className="w-full inline-flex items-center justify-center h-8 px-3 bg-accent hover:opacity-90 text-white text-xs font-medium rounded-sm transition-colors disabled:opacity-50"
        >
          Use this leaf
        </button>
      </div>
    </div>
  );
}
