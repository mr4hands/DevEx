export type Resource = {
  address: string;
  type: string;
  name: string;
  module: string;
  mode: string;
  provider: string;
  values: Record<string, unknown>;
};

export type ResourceGroup = {
  type: string;
  resources: Resource[];
};

export type PlanResponse = {
  tofu_root: string;
  terraform_version?: string;
  format_version?: string;
  resource_count: number;
  groups: ResourceGroup[];
};

export type ActionKind =
  | "create"
  | "update"
  | "delete"
  | "replace"
  | "import"
  | "import_update"
  | "no-op"
  | "read"
  | string; // tolerate unknowns

export type ResourceChange = {
  address: string;
  type: string;
  name: string;
  module: string;
  provider: string;
  mode: string;
  actions: string[];
  action_kind: ActionKind;
  importing_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

export type PlanDiffResponse = {
  tofu_root: string;
  terraform_version?: string;
  format_version?: string;
  total_changes: number;
  visible_changes: number;
  counts: Record<string, number>;
  changes: ResourceChange[];
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[];
};

export type ToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  label?: string; // pre-result hint, e.g. file path
  summary?: string; // post-result short status
  isError?: boolean;
};

export type StreamEvent =
  | { kind: "text"; data: { delta: string } }
  | {
      kind: "tool_use";
      data: {
        id: string;
        name: string;
        input: Record<string, unknown>;
        summary?: string;
      };
    }
  | {
      kind: "tool_result";
      data: { tool_use_id: string; is_error: boolean; summary: string };
    }
  | { kind: "done"; data: Record<string, never> }
  | { kind: "error"; data: { message: string } };
