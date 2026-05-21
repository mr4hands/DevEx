import type {
  BlueprintResourcesResponse,
  ChatMessage,
  ExistingResourcesResponse,
  InventoryResponse,
  PlanDiffResponse,
  PlanResponse,
  SchemasResponse,
  StreamEvent,
} from "./types";

export async function fetchPlan(): Promise<PlanResponse> {
  const res = await fetch("/api/plan", { cache: "no-store" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/plan failed (${res.status}): ${text}`);
  }
  return res.json();
}

export type PlanRoot = "default" | "blueprint";

export async function fetchPlanDiff(
  signal?: AbortSignal,
  root: PlanRoot = "default",
): Promise<PlanDiffResponse> {
  const qs = `?root=${encodeURIComponent(root)}`;
  const res = await fetch(`/api/plan-diff${qs}`, { cache: "no-store", signal });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/plan-diff failed (${res.status}): ${text}`);
  }
  return res.json();
}

/** Returns provider schemas for the Blueprint canvas's supported types. */
export async function fetchSchemas(
  types?: string[],
  signal?: AbortSignal,
): Promise<SchemasResponse> {
  const qs = types && types.length > 0
    ? "?" + types.map((t) => `types=${encodeURIComponent(t)}`).join("&")
    : "";
  const res = await fetch(`/api/schemas${qs}`, { cache: "no-store", signal });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/schemas failed (${res.status}): ${text}`);
  }
  return res.json();
}

/** Lists the Blueprint workspace's resources (nodes + dependency edges). */
export async function fetchBlueprintResources(
  signal?: AbortSignal,
): Promise<BlueprintResourcesResponse> {
  const res = await fetch("/api/blueprint/resources", {
    cache: "no-store",
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/blueprint/resources failed (${res.status}): ${text}`);
  }
  return res.json();
}

/** Persists a batch of canvas node positions to `_layout.json`. Used
 *  by the drag-to-save flow — debounced client-side so a single drag
 *  produces one request, not one per pixel. Keys are `<type>.<name>`. */
export async function patchBlueprintLayout(
  positions: Record<string, { x: number; y: number }>,
  signal?: AbortSignal,
): Promise<{ updated: number }> {
  const res = await fetch("/api/blueprint/layout", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ positions }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `/api/blueprint/layout failed (${res.status}): ${text}`,
    );
  }
  return res.json();
}

/** Deletes a resource's .tf file + its layout entry. Idempotent. */
export async function deleteBlueprintResource(
  type: string,
  name: string,
  signal?: AbortSignal,
): Promise<{
  type: string;
  name: string;
  deleted_file: boolean;
  deleted_layout_entry: boolean;
}> {
  const res = await fetch(
    `/api/blueprint/resource/${encodeURIComponent(type)}/${encodeURIComponent(name)}`,
    { method: "DELETE", signal },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `/api/blueprint/resource DELETE failed (${res.status}): ${text}`,
    );
  }
  return res.json();
}

/** Saves a resource to the Blueprint workspace as its own .tf file. */
export async function writeBlueprintResource(
  body: {
    type: string;
    name: string;
    import_id?: string | null;
    attributes: Record<string, unknown>;
    blocks?: Record<
      string,
      Array<{
        attributes: Record<string, unknown>;
        blocks: Record<string, unknown>;
      }>
    >;
    position?: { x: number; y: number } | null;
  },
  signal?: AbortSignal,
): Promise<{ type: string; name: string; path: string; hcl: string }> {
  const res = await fetch("/api/blueprint/resource", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/blueprint/resource failed (${res.status}): ${text}`);
  }
  return res.json();
}

/** Unified resource inventory (managed + unmanaged), classified by
 *  account/region/component. The tree groups this client-side. */
export async function fetchInventory(
  signal?: AbortSignal,
): Promise<InventoryResponse> {
  const res = await fetch("/api/inventory", { cache: "no-store", signal });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/inventory failed (${res.status}): ${text}`);
  }
  return res.json();
}

/** Reads the discovery manifest the agent skill writes. Deterministic —
 *  no LLM. `scope` filters to one resource type. */
export async function fetchExistingResources(
  signal?: AbortSignal,
  scope?: string,
): Promise<ExistingResourcesResponse> {
  const qs = scope ? `?scope=${encodeURIComponent(scope)}` : "";
  const res = await fetch(`/api/existing-resources${qs}`, {
    cache: "no-store",
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/existing-resources failed (${res.status}): ${text}`);
  }
  return res.json();
}

/** Swaps an adopted resource's thin body for apply-clean HCL via
 *  generate-config-out. Preserves the import block. */
export async function generateBlueprintConfig(
  type: string,
  name: string,
  signal?: AbortSignal,
): Promise<{ type: string; name: string; hcl: string }> {
  const res = await fetch("/api/blueprint/generate-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, name }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `/api/blueprint/generate-config failed (${res.status}): ${text}`,
    );
  }
  return res.json();
}

/** Streams Server-Sent Events from POST /api/chat. */
export async function* streamChat(
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`/api/chat failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // SSE frames are separated by blank lines.
    let idx = buf.indexOf("\n\n");
    while (idx !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const evt = parseFrame(frame);
      if (evt) yield evt;
      idx = buf.indexOf("\n\n");
    }
  }
}

function parseFrame(frame: string): StreamEvent | null {
  let event = "message";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return null;
  try {
    const payload = JSON.parse(data);
    return { kind: event as StreamEvent["kind"], data: payload } as StreamEvent;
  } catch {
    return null;
  }
}
