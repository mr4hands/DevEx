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

/**
 * Provider-schema attribute as returned by `/api/schemas`. The `type`
 * field comes from OpenTofu's normalized provider schema; it may be a
 * string ("string", "number", "bool") or a nested array
 * (`["map", "string"]`, `["set", ["object", {...}]]`, etc.) — leave
 * it as `unknown` and let the form renderer narrow on demand.
 */
export type ResourceAttribute = {
  name: string;
  type: unknown;
  description: string;
  required: boolean;
  optional: boolean;
  /** True for optional-computed attributes — the user may set them, but
   *  AWS fills a value if left blank (e.g. `bucket`, `cidr_block`). */
  computed: boolean;
  /** True for AWS-assigned attributes the user must not author: pure
   *  computed outputs (`arn`, `region`, …) plus `id` / `tags_all`. The
   *  form shows these disabled ("known after apply" when no value yet). */
  read_only: boolean;
  sensitive: boolean;
  deprecated: boolean;
};

/**
 * Recursive nested-block schema. `attributes` + `block_types` mirror
 * the top-level resource schema, allowing the form to render N levels
 * deep (capped by the backend at `_MAX_BLOCK_DEPTH`). `truncated`
 * means the backend stopped recursing on this branch; the UI hints
 * at it instead of pretending the block has no nesting.
 */
export type ResourceBlockType = {
  name: string;
  nesting_mode: string;
  description: string;
  min_items: number;
  max_items: number;
  attributes: ResourceAttribute[];
  block_types: ResourceBlockType[];
  truncated: boolean;
};

/** One instance of a nested block in the canvas write/read shape.
 *  Mirrors `BlockInstance` in the backend Pydantic model. */
export type BlueprintBlockInstance = {
  attributes: Record<string, unknown>;
  blocks: Record<string, BlueprintBlockInstance[]>;
};

export type ResourceSchema = {
  label: string;
  family: string;
  attributes: ResourceAttribute[];
  block_types: ResourceBlockType[];
};

export type SchemasResponse = {
  blueprint_root: string;
  provider: string;
  resources: Record<string, ResourceSchema>;
};

export type BlueprintResource = {
  type: string;
  name: string;
  /** Real cloud id when this resource was adopted via an import block;
   *  null/absent for resources authored from scratch. */
  import_id?: string | null;
  attributes: Record<string, unknown>;
  /** Nested blocks (`versioning`, `lifecycle_rule`, etc.) when the
   *  resource was successfully parsed. Always present in the response
   *  shape post-Phase 4 — `{}` when the resource has no blocks. */
  blocks: Record<string, BlueprintBlockInstance[]>;
  position: { x: number; y: number };
  filename: string;
  parse_error?: string;
};

export type BlueprintEdge = {
  source: string; // "<type>.<name>"
  target: string; // "<type>.<name>"
};

export type BlueprintResourcesResponse = {
  blueprint_root: string;
  resources: BlueprintResource[];
  edges: BlueprintEdge[];
};

/** One discovered (unmanaged) AWS resource in the discovery manifest the
 *  agent skill writes. Draggable onto the canvas to adopt it. */
export type ExistingResource = {
  address: string;
  type: string;
  name: string;
  import_id: string;
  summary_attributes: Record<string, unknown>;
};

export type ExistingResourceGroup = {
  type: string;
  resources: ExistingResource[];
};

export type ExistingResourcesResponse = {
  source: string | null;
  generated_at: string | null;
  scopes_loaded: string[];
  groups: ExistingResourceGroup[];
  /** Present when there's no manifest yet (cold start). */
  hint?: string;
  /** Present when the manifest on disk is malformed. */
  error?: string;
};

export type InventoryResource = {
  address: string;
  type: string;
  name: string;
  id: string | null;
  arn: string | null;
  account: string;
  region: string;
  managed: boolean;
  component: string;
  component_source: "tag" | "override" | "unassigned" | string;
  tags: Record<string, unknown>;
  values: Record<string, unknown>;
};

export type InventoryResponse = {
  resources: InventoryResource[];
  components: Record<string, { display_name?: string; target_module?: string }>;
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
