"use client";

import { useCallback, useRef, useState } from "react";

import { streamChat } from "@/lib/api";
import type { ChatMessage, ToolCall } from "@/lib/types";

export function ChatPanel({
  onToolResult,
}: {
  /** Fired after every tool result — useful to refresh the resource list. */
  onToolResult?: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const send = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || busy) return;

    const userMsg: ChatMessage = { role: "user", content: trimmed };
    const next: ChatMessage[] = [...messages, userMsg, { role: "assistant", content: "" }];
    setMessages(next);
    setInput("");
    setBusy(true);
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const history = next.slice(0, -1); // drop the empty placeholder we'll fill
      const stream = streamChat(history, controller.signal);
      let assistantText = "";
      const toolCalls: ToolCall[] = [];
      for await (const evt of stream) {
        if (evt.kind === "text") {
          assistantText += evt.data.delta;
          setMessages((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = {
              role: "assistant",
              content: assistantText,
              toolCalls: [...toolCalls],
            };
            return copy;
          });
        } else if (evt.kind === "tool_use") {
          toolCalls.push({
            id: evt.data.id,
            name: evt.data.name,
            input: evt.data.input,
            label: evt.data.summary,
          });
          setMessages((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = {
              role: "assistant",
              content: assistantText,
              toolCalls: [...toolCalls],
            };
            return copy;
          });
        } else if (evt.kind === "tool_result") {
          const match = toolCalls.find((tc) => tc.id === evt.data.tool_use_id);
          if (match) {
            match.summary = evt.data.summary;
            match.isError = evt.data.is_error;
          }
          setMessages((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = {
              role: "assistant",
              content: assistantText,
              toolCalls: [...toolCalls],
            };
            return copy;
          });
          onToolResult?.();
        } else if (evt.kind === "error") {
          setError(evt.data.message);
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError((e as Error).message);
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      });
    }
  }, [busy, input, messages, onToolResult]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold">Chat</h2>
        <p className="text-xs text-muted-foreground">
          Ask about resources in <code>live/dev</code>. The agent can call{" "}
          <code>get_plan_resources</code> to inspect them.
        </p>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Try: <em>what resources are in this plan?</em>
          </p>
        )}
        {messages.map((m, i) => (
          <MessageBubble key={i} msg={m} />
        ))}
        {error && (
          <div className="text-xs text-red-600 dark:text-red-400 rounded border border-red-200 dark:border-red-900 px-3 py-2">
            {error}
          </div>
        )}
      </div>

      <form
        className="border-t border-border p-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          className="flex-1 rounded border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
          placeholder={busy ? "thinking…" : "Ask about the plan"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />
        {busy ? (
          <button
            type="button"
            className="rounded bg-muted px-3 py-2 text-sm border border-border"
            onClick={cancel}
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            className="rounded bg-accent px-3 py-2 text-sm text-white disabled:opacity-50"
            disabled={!input.trim()}
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[90%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words ${
          isUser
            ? "bg-accent text-white"
            : "bg-muted text-foreground border border-border"
        }`}
      >
        {msg.toolCalls && msg.toolCalls.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {msg.toolCalls.map((tc) => (
              <span
                key={tc.id}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-mono border ${
                  tc.isError
                    ? "bg-red-50 border-red-200 text-red-700 dark:bg-red-950 dark:border-red-900 dark:text-red-300"
                    : "bg-background border-border text-muted-foreground"
                }`}
                title={JSON.stringify(tc.input)}
              >
                <span>{tc.isError ? "⚠" : "🔧"}</span>
                <span>{tc.name}</span>
                {tc.label && <span className="opacity-60">{tc.label}</span>}
                {tc.summary && tc.summary !== "ok" && (
                  <span className="opacity-60">— {tc.summary}</span>
                )}
              </span>
            ))}
          </div>
        )}
        {msg.content || (msg.role === "assistant" && <span className="opacity-50">…</span>)}
      </div>
    </div>
  );
}
