"use client";

import { useState } from "react";

import { writeDraft } from "@/lib/api";
import { PALETTE } from "@/lib/blueprintPalette";

const _NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Fast "add a resource to a component" form. Picks a type + name and
 * writes a `new` draft tagged with the component; the resource then shows
 * under that component (draft) and can be filled in via the inspector.
 * Also offers an "ask the agent instead" escape hatch.
 */
export function QuickCreate({
  component,
  onCreated,
  onCancel,
  onAskAgent,
}: {
  component: string;
  onCreated: () => void;
  onCancel: () => void;
  onAskAgent: (component: string) => void;
}) {
  const [type, setType] = useState(PALETTE[0]?.type ?? "aws_s3_bucket");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const valid = _NAME_RE.test(name);

  const create = async () => {
    if (!valid) return;
    setBusy(true);
    setErr(null);
    try {
      await writeDraft({ kind: "new", type, name, component });
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-background">
      <div className="shrink-0 border-b border-border px-3 pt-3 pb-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
            Add to component
          </div>
          <div className="font-mono text-sm text-foreground break-all">
            {component}
          </div>
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel"
          className="shrink-0 h-6 px-2 inline-flex items-center justify-center text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted rounded-sm transition-colors"
        >
          cancel
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-3 text-xs">
        <div>
          <label className="text-[10px] uppercase tracking-wide text-foreground font-mono">
            type
          </label>
          <select
            className="mt-1 w-full text-xs font-mono rounded-sm border border-border bg-background px-2 py-1 outline-none focus:border-accent"
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            {PALETTE.map((p) => (
              <option key={p.type} value={p.type}>
                {p.label} ({p.type})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wide text-foreground font-mono">
            name
          </label>
          <input
            autoFocus
            className="mt-1 w-full text-xs font-mono rounded-sm border border-border bg-background px-2 py-1 outline-none focus:border-accent"
            value={name}
            placeholder="e.g. solr_extra"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && valid && !busy) void create();
            }}
          />
          {name && !valid && (
            <p className="mt-0.5 text-[10px] text-red-600 dark:text-red-400">
              Must be a valid identifier (letters, digits, _).
            </p>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground">
          Creates a draft tagged <span className="font-mono">Component=
          {component}</span>. Fill in its attributes in the inspector, then
          commit to a PR.
        </p>
        {err && (
          <p className="text-[10px] text-red-600 dark:text-red-400 break-words">
            {err}
          </p>
        )}
      </div>

      <div className="shrink-0 border-t border-border px-3 py-2.5 bg-muted/40 space-y-2">
        <button
          type="button"
          onClick={() => void create()}
          disabled={!valid || busy}
          className="w-full inline-flex items-center justify-center h-8 px-3 bg-accent hover:opacity-90 text-white text-xs font-medium rounded-sm transition-colors disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create draft"}
        </button>
        <button
          type="button"
          onClick={() => onAskAgent(component)}
          className="w-full inline-flex items-center justify-center h-7 px-3 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted rounded-sm transition-colors"
        >
          or ask the agent instead →
        </button>
      </div>
    </div>
  );
}
