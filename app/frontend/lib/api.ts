import type {
  BlueprintResourcesResponse,
  ChatMessage,
  DraftRequest,
  DraftsResponse,
  ExistingResourcesResponse,
  Hierarchy,
  InventoryResponse,
  LeafCoords,
  PlanDiffResponse,
  PlanResponse,
  PromoteResponse,
  SchemasResponse,
  StreamEvent,
} from "./types";

/** Mirrors the backend `_COORD_RE` in leaves.py. Each leaf coord segment
 *  must satisfy this before we send a draft, so the user gets an inline
 *  error instead of a 400. */
export const COORD_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

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
  leaf?: string,
): Promise<PlanDiffResponse> {
  let qs = `?root=${encodeURIComponent(root)}`;
  if (leaf) qs += `&leaf=${encodeURIComponent(leaf)}`;
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

/** Reads the hierarchy mapping (components + overrides). */
export async function fetchHierarchy(signal?: AbortSignal): Promise<Hierarchy> {
  const res = await fetch("/api/hierarchy", { cache: "no-store", signal });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/hierarchy failed (${res.status}): ${text}`);
  }
  return res.json();
}

/** Assigns a resource to a component (override). Creates the component on
 *  the fly server-side if it's new. Returns the updated hierarchy. */
export async function setComponentOverride(
  address: string,
  component: string,
  signal?: AbortSignal,
): Promise<Hierarchy> {
  const res = await fetch("/api/hierarchy/override", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, component }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/hierarchy/override failed (${res.status}): ${text}`);
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

/** Create/update a draft (new/adopt/edit/delete) for the current owner. */
export async function writeDraft(
  body: DraftRequest,
  signal?: AbortSignal,
): Promise<{ address: string; owner: string; hcl: string }> {
  const res = await fetch("/api/blueprint/draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/blueprint/draft failed (${res.status}): ${text}`);
  }
  return res.json();
}

/** Lists the current owner's pending drafts (for the pending-changes bar). */
export async function fetchDrafts(
  signal?: AbortSignal,
): Promise<DraftsResponse> {
  const res = await fetch("/api/blueprint/drafts", {
    cache: "no-store",
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/blueprint/drafts failed (${res.status}): ${text}`);
  }
  return res.json();
}

/** Discard a draft. The backend needs the leaf coords to find the file. */
export async function discardDraft(
  type: string,
  name: string,
  coords: LeafCoords,
  signal?: AbortSignal,
): Promise<{ discarded: boolean }> {
  const res = await fetch(
    `/api/blueprint/draft/${encodeURIComponent(type)}/${encodeURIComponent(name)}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(coords),
      signal,
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`discard draft failed (${res.status}): ${text}`);
  }
  return res.json();
}

/** Deterministically promote the owner's overlay into devex-live and open a
 *  PR. No agent. Returns the PR URL. */
export async function promoteDrafts(
  signal?: AbortSignal,
): Promise<PromoteResponse> {
  const res = await fetch("/api/blueprint/promote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/blueprint/promote failed (${res.status}): ${text}`);
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
