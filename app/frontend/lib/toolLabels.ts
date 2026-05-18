/**
 * Display metadata for the agent's tools — color, short label, verb,
 * and a function that extracts the most relevant single string from
 * the tool's input (e.g., file path for Read, command for Bash).
 *
 * Used by `ChatPanel`'s activity-card rendering.
 */

export type ToolMeta = {
  /** 2-5 char uppercase label shown in the row (e.g. "BASH", "READ"). */
  label: string;
  /** Tailwind class string for the label. */
  labelColor: string;
  /** Verb used in the active-state line ("Reading X...", "Running X..."). */
  activeVerb: string;
  /** Extract the most useful single-string descriptor of the call. */
  target: (input: Record<string, unknown>) => string;
};

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function firstNonEmpty(input: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const s = asString(input[k]);
    if (s) return s;
  }
  return "";
}

const DEFAULT_META: ToolMeta = {
  label: "TOOL",
  labelColor: "text-muted-foreground",
  activeVerb: "Running",
  target: (input) => firstNonEmpty(input, "name", "path", "command", "query"),
};

const META: Record<string, ToolMeta> = {
  Bash: {
    label: "BASH",
    labelColor: "text-stone-700 dark:text-stone-300",
    activeVerb: "Running",
    target: (i) => firstNonEmpty(i, "command", "description"),
  },
  Read: {
    label: "READ",
    labelColor: "text-sky-700 dark:text-sky-400",
    activeVerb: "Reading",
    target: (i) => firstNonEmpty(i, "file_path", "path"),
  },
  Write: {
    label: "WRITE",
    labelColor: "text-emerald-700 dark:text-emerald-400",
    activeVerb: "Writing",
    target: (i) => firstNonEmpty(i, "file_path", "path"),
  },
  Edit: {
    label: "EDIT",
    labelColor: "text-amber-800 dark:text-amber-400",
    activeVerb: "Editing",
    target: (i) => firstNonEmpty(i, "file_path", "path"),
  },
  Grep: {
    label: "GREP",
    labelColor: "text-violet-700 dark:text-violet-400",
    activeVerb: "Searching",
    target: (i) => {
      const q = firstNonEmpty(i, "pattern", "query");
      const path = firstNonEmpty(i, "path");
      return path ? `${q} ${path}` : q;
    },
  },
  Glob: {
    label: "GLOB",
    labelColor: "text-violet-700 dark:text-violet-400",
    activeVerb: "Searching",
    target: (i) => firstNonEmpty(i, "pattern", "query"),
  },
  WebFetch: {
    label: "WEB",
    labelColor: "text-rose-700 dark:text-rose-400",
    activeVerb: "Fetching",
    target: (i) => firstNonEmpty(i, "url"),
  },
  WebSearch: {
    label: "WEB",
    labelColor: "text-rose-700 dark:text-rose-400",
    activeVerb: "Searching",
    target: (i) => firstNonEmpty(i, "query"),
  },
};

export function metaFor(toolName: string): ToolMeta {
  return META[toolName] ?? DEFAULT_META;
}
