"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { streamChat } from "@/lib/api";
import { FAMILY_CLASSES, familyOf, leafOf } from "@/lib/resourceFamilies";
import { metaFor } from "@/lib/toolLabels";
import type { ChatMessage, Resource, ToolCall } from "@/lib/types";

/**
 * Chat panel rendering the agent's turn as an Activity Card (Claude Design
 * Session 3, Variant A) plus ambient context (Session 5, Variant A).
 *
 *   - Selected resource auto-attaches as the chat's context. The chip
 *     above the composer shows what's attached; clear with the × or
 *     ⌘⇧X / Ctrl+Shift+X.
 *   - Active turn state: amber header with a pulsing dot +
 *     "Reading X..." verb-target line.
 *   - Completed turn state: stone header that's a collapsible button +
 *     stack of tool rows. Each row is click-to-expand for input/result.
 *
 * Context is prepended to outgoing user messages so the backend (which
 * doesn't yet know about context) sees a single coherent prompt.
 */
export function ChatPanel({
  onToolResult,
  contextResource,
  onClearContext,
}: {
  onToolResult?: () => void;
  /** Resource currently selected in the middle pane; auto-attaches as
   *  context for every message sent. Null disables the chip. */
  contextResource?: Resource | null;
  /** Clears the context — wired to ResourceList's selection setter. */
  onClearContext?: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const send = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || busy) return;

    // The user sees their original message in the transcript; the
    // backend gets the context prepended as a [Context: …] line. The
    // backend currently has no context-aware field, so prepending is
    // the lightest-touch way to make the chat agent aware of what the
    // user is looking at.
    const visibleContent = trimmed;
    const sentContent = contextResource
      ? `[Context: ${contextResource.address} (${contextResource.type})]\n\n${trimmed}`
      : trimmed;
    const userMsgVisible: ChatMessage = { role: "user", content: visibleContent };
    const userMsgSent: ChatMessage = { role: "user", content: sentContent };
    const next: ChatMessage[] = [
      ...messages,
      userMsgVisible,
      { role: "assistant", content: "" },
    ];
    const nextSent: ChatMessage[] = [
      ...messages,
      userMsgSent,
      { role: "assistant", content: "" },
    ];
    setMessages(next);
    setInput("");
    setBusy(true);
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const history = nextSent.slice(0, -1);
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
  }, [busy, input, messages, onToolResult, contextResource]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  useEffect(() => {
    // Auto-scroll to bottom on new content.
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // ⌘⇧X / Ctrl+Shift+X clears the ambient context.
  useEffect(() => {
    if (!onClearContext) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        e.shiftKey &&
        (e.metaKey || e.ctrlKey) &&
        (e.key === "x" || e.key === "X")
      ) {
        e.preventDefault();
        onClearContext();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClearContext]);

  return (
    <div className="flex flex-col h-full min-h-0 bg-background">
      {/* Local CSS keyframes for the dot-pulse + bouncing-dots animation.
          Inlining here avoids a Tailwind v4 @theme extension just for two
          short keyframes. */}
      <style>{`
        @keyframes cp-pulse { 0%,100% { transform: scale(1); opacity: 0.5 } 50% { transform: scale(1.8); opacity: 0 } }
        @keyframes cp-dots  { 0%,20% { opacity: 0 } 50% { opacity: 1 } 100% { opacity: 0 } }
        .cp-pulse-ring { animation: cp-pulse 1.6s infinite ease-out; }
        .cp-dot1 { animation: cp-dots 1.2s infinite; animation-delay: 0s; }
        .cp-dot2 { animation: cp-dots 1.2s infinite; animation-delay: .15s; }
        .cp-dot3 { animation: cp-dots 1.2s infinite; animation-delay: .3s; }
      `}</style>

      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-3 h-9 border-b border-border">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          chat
        </span>
        <span className="text-[10px] font-mono text-muted-foreground">
          claude · debug
        </span>
      </div>

      {/* Message stream */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0">
        {messages.length === 0 && (
          <p className="m-3 text-xs text-muted-foreground">
            Try: <em>what resources are in this plan?</em>
          </p>
        )}
        {messages.map((m, i) => (
          <MessageBlock
            key={i}
            msg={m}
            isLast={i === messages.length - 1}
            busy={busy && i === messages.length - 1}
          />
        ))}
        {error && (
          <div className="m-3 text-xs rounded-sm border border-red-200 dark:border-red-900 px-3 py-2 text-red-600 dark:text-red-400">
            {error}
          </div>
        )}
      </div>

      {/* Composer area — context chip above, textarea below */}
      <div className="shrink-0 border-t border-border p-2 bg-muted/40">
        {contextResource && (
          <ContextChip
            resource={contextResource}
            onClear={onClearContext}
          />
        )}
        <form
          className="border border-border bg-background rounded-sm px-2 py-1.5 flex items-end gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <textarea
            ref={textareaRef}
            rows={2}
            className="flex-1 text-xs resize-none outline-none bg-transparent placeholder:text-muted-foreground/70"
            placeholder={
              busy
                ? "thinking…"
                : contextResource
                  ? "ask anything — selected resource is attached…"
                  : "ask about the plan"
            }
            value={input}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          {busy ? (
            <button
              type="button"
              className="h-6 px-2 text-[11px] bg-muted border border-border text-foreground rounded-sm transition-colors"
              onClick={cancel}
            >
              stop
            </button>
          ) : (
            <button
              type="submit"
              className="h-6 px-2 text-[11px] bg-accent hover:opacity-90 text-white rounded-sm transition-colors disabled:opacity-50"
              disabled={!input.trim()}
            >
              send
            </button>
          )}
        </form>
        {contextResource && (
          <div className="mt-1.5 text-[10px] font-mono text-muted-foreground">
            context auto-attaches · clear with ⌘⇧X
          </div>
        )}
      </div>
    </div>
  );
}

function MessageBlock({
  msg,
  isLast,
  busy,
}: {
  msg: ChatMessage;
  isLast: boolean;
  busy: boolean;
}) {
  if (msg.role === "user") {
    return (
      <div className="px-3 py-2">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
          you
        </div>
        <div className="text-xs text-foreground leading-snug bg-muted rounded-sm px-2.5 py-2 border border-border whitespace-pre-wrap break-words">
          {msg.content}
        </div>
      </div>
    );
  }
  // Assistant
  return (
    <div className="px-3 pt-1 pb-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
        assistant
      </div>
      {msg.toolCalls && msg.toolCalls.length > 0 && (
        <ActivityCard
          toolCalls={msg.toolCalls}
          // Active when the last call has no summary yet AND this is the
          // current streaming turn.
          active={busy && isLast && lastCallIsRunning(msg.toolCalls)}
        />
      )}
      {msg.content && (
        <div className="text-xs text-foreground leading-relaxed whitespace-pre-wrap break-words">
          {msg.content}
        </div>
      )}
      {!msg.content && busy && isLast && (!msg.toolCalls || msg.toolCalls.length === 0) && (
        <ThinkingLine />
      )}
    </div>
  );
}

function lastCallIsRunning(calls: ToolCall[]): boolean {
  const last = calls[calls.length - 1];
  return !!last && last.summary === undefined && last.isError === undefined;
}

function ActivityCard({
  toolCalls,
  active,
}: {
  toolCalls: ToolCall[];
  active: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [openTool, setOpenTool] = useState<string | null>(null);

  // When the turn finishes (active flips false), collapse the card by
  // default to reclaim space. But keep the previously-opened tool open
  // so the user doesn't lose their place. This is a syncs-prop-into-
  // state pattern; the lint rule is overly cautious here.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setCollapsed(!active), [active]);

  if (active) {
    const current = toolCalls[toolCalls.length - 1]!;
    const meta = metaFor(current.name);
    const target = meta.target(current.input ?? {});
    return (
      <div className="border border-border rounded-sm overflow-hidden mb-2">
        <div className="flex items-center gap-2 px-2.5 h-8 bg-amber-50 dark:bg-amber-950/40 border-b border-border">
          <PulsingDot />
          <span className="text-[11px] text-foreground">
            {meta.activeVerb}{" "}
            <span className="font-mono text-foreground" title={target}>
              {truncate(target, 32)}
            </span>
            <span className="cp-dot1">.</span>
            <span className="cp-dot2">.</span>
            <span className="cp-dot3">.</span>
          </span>
          <span className="ml-auto text-[10px] font-mono text-muted-foreground tabular-nums">
            {toolCalls.length} tool{toolCalls.length === 1 ? "" : "s"}
          </span>
        </div>
        <ToolList
          calls={toolCalls.slice(0, -1)}
          openTool={openTool}
          onToggle={setOpenTool}
          showChevrons={false}
        />
      </div>
    );
  }

  // Completed
  return (
    <div className="border border-border rounded-sm overflow-hidden mb-2">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center gap-2 px-2.5 h-8 bg-muted hover:bg-muted/70 border-b border-border transition-colors"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="9"
          height="9"
          viewBox="0 0 10 10"
          fill="none"
          className={`text-muted-foreground transition-transform ${collapsed ? "" : "rotate-90"}`}
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
        <span className="text-[11px] text-foreground">
          Ran {toolCalls.length} tool{toolCalls.length === 1 ? "" : "s"}
        </span>
        <span className="ml-auto text-[10px] font-mono text-muted-foreground">
          {collapsed ? "expand" : "collapse"}
        </span>
      </button>
      {!collapsed && (
        <ToolList
          calls={toolCalls}
          openTool={openTool}
          onToggle={setOpenTool}
          showChevrons
        />
      )}
    </div>
  );
}

function PulsingDot() {
  return (
    <span className="relative inline-flex items-center justify-center w-2 h-2">
      <span className="absolute inset-0 rounded-full bg-amber-400 opacity-60 cp-pulse-ring" />
      <span className="relative w-1.5 h-1.5 rounded-full bg-amber-500" />
    </span>
  );
}

function ToolList({
  calls,
  openTool,
  onToggle,
  showChevrons,
}: {
  calls: ToolCall[];
  openTool: string | null;
  onToggle: (id: string | null) => void;
  showChevrons: boolean;
}) {
  return (
    <ul className="text-[11px] divide-y divide-border">
      {calls.map((tc) => {
        const meta = metaFor(tc.name);
        const target = meta.target(tc.input ?? {});
        const open = openTool === tc.id;
        return (
          <li key={tc.id}>
            <button
              type="button"
              onClick={() =>
                showChevrons ? onToggle(open ? null : tc.id) : undefined
              }
              disabled={!showChevrons}
              className="w-full flex items-center gap-2 px-2.5 h-7 text-left hover:bg-muted/60 transition-colors disabled:cursor-default disabled:hover:bg-transparent"
            >
              <StatusIcon isError={tc.isError} running={tc.summary === undefined && tc.isError === undefined} />
              <span
                className={`font-mono text-[10px] uppercase tracking-wide w-8 ${meta.labelColor}`}
              >
                {meta.label}
              </span>
              <span
                className="font-mono text-[11px] text-foreground truncate min-w-0 flex-1"
                title={target}
              >
                {target}
              </span>
              {tc.summary && (
                <span
                  className={
                    "text-[10px] font-mono shrink-0 " +
                    (tc.isError ? "text-red-600 dark:text-red-400" : "text-muted-foreground")
                  }
                >
                  {truncate(tc.summary, 16)}
                </span>
              )}
              {showChevrons && (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="9"
                  height="9"
                  viewBox="0 0 10 10"
                  fill="none"
                  className={`text-muted-foreground/60 transition-transform ${open ? "rotate-90" : ""}`}
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
              )}
            </button>
            {open && (
              <div className="px-2.5 pb-2.5 pt-1 bg-muted/40 border-t border-border">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                  input
                </div>
                <pre className="text-[10.5px] font-mono bg-background border border-border px-2 py-1.5 rounded-sm text-foreground overflow-x-auto leading-snug whitespace-pre-wrap break-words">
                  {JSON.stringify(tc.input ?? {}, null, 2)}
                </pre>
                {tc.summary !== undefined && (
                  <>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground mt-2 mb-1 flex items-center justify-between">
                      <span>result</span>
                      <span
                        className={
                          "font-mono text-[10px] " +
                          (tc.isError ? "text-red-600 dark:text-red-400" : "text-muted-foreground")
                        }
                      >
                        {tc.isError ? "error" : "ok"}
                      </span>
                    </div>
                    <pre className="text-[10.5px] font-mono bg-background border border-border px-2 py-1.5 rounded-sm text-foreground overflow-x-auto leading-snug whitespace-pre-wrap break-words">
                      {tc.summary || "(empty)"}
                    </pre>
                  </>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function StatusIcon({
  isError,
  running,
}: {
  isError?: boolean;
  running: boolean;
}) {
  if (running) {
    return (
      <span className="inline-flex items-center justify-center w-2.5">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 cp-pulse-ring" />
      </span>
    );
  }
  if (isError) {
    return (
      <span className="text-red-600 dark:text-red-400">
        <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 10 10" fill="none">
          <path
            d="M2.5 2.5l5 5M7.5 2.5l-5 5"
            stroke="currentColor"
            strokeWidth="1.4"
            fill="none"
            strokeLinecap="round"
          />
        </svg>
      </span>
    );
  }
  return (
    <span className="text-emerald-600 dark:text-emerald-400">
      <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 10 10" fill="none">
        <path
          d="M2 5.5l2 2 4-5"
          stroke="currentColor"
          strokeWidth="1.4"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function ThinkingLine() {
  return (
    <div className="text-xs text-muted-foreground flex items-center gap-0.5">
      <span>thinking</span>
      <span className="cp-dot1">.</span>
      <span className="cp-dot2">.</span>
      <span className="cp-dot3">.</span>
    </div>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * Ambient context chip rendered above the textarea. Shows the family
 * monogram + leaf name of the resource the user has selected; an ×
 * button (or ⌘⇧X) clears it.
 */
function ContextChip({
  resource,
  onClear,
}: {
  resource: Resource;
  onClear?: () => void;
}) {
  const meta = familyOf(resource.type);
  const classes = FAMILY_CLASSES[meta.family];
  const leaf = leafOf(resource.address);
  return (
    <div className="flex items-center gap-1.5 mb-2 px-2 h-7 bg-background border border-amber-300 dark:border-amber-700 rounded-sm">
      <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-amber-500 text-white text-[9px] font-mono leading-none">
        1
      </span>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        context
      </span>
      <span
        className={`inline-flex items-center justify-center px-1 h-[16px] min-w-[22px] rounded-sm ring-1 ring-inset font-mono text-[10px] uppercase ${classes.chip}`}
      >
        {meta.monogram}
      </span>
      <span
        className="font-mono text-[11px] text-foreground truncate min-w-0 flex-1"
        title={resource.address}
      >
        {leaf}
      </span>
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear context"
          title="Clear context (⌘⇧X)"
          className="shrink-0 inline-flex items-center justify-center w-4 h-4 text-muted-foreground hover:text-foreground rounded-sm"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 12 12" fill="none">
            <path
              d="M2.5 2.5l7 7M9.5 2.5l-7 7"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
