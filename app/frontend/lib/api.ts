import type {
  ChatMessage,
  PlanDiffResponse,
  PlanResponse,
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

export async function fetchPlanDiff(
  signal?: AbortSignal,
): Promise<PlanDiffResponse> {
  const res = await fetch("/api/plan-diff", { cache: "no-store", signal });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/plan-diff failed (${res.status}): ${text}`);
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
