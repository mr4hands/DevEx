"""Claude Agent SDK chat session.

Wraps `claude_agent_sdk.query()` so the chat agent in the UI has the same
toolset Claude Code uses: Read, Glob, Grep, Bash, Edit, Write, WebFetch.
The agent's `cwd` is the repo root and `setting_sources=["project"]` makes
it inherit this repo's CLAUDE.md, .claude/settings.json, and skills —
which means the deny list (no `tofu apply`, no `tofu destroy`, etc.)
applies to the agent the same way it applies to Claude Code itself.

Streaming: we relay the SDK's `StreamEvent` partial deltas as SSE `text`
events, and surface `ToolUseBlock` / `ToolResultBlock` as `tool_use` /
`tool_result` SSE events. The frontend renders tool calls as pill badges.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
    query,
)

from .settings import get_settings

SYSTEM_PROMPT_APPEND = """You are the chat agent inside the DevEx Platform
UI. The user is browsing OpenTofu resources in a side panel and chatting
with you here. The repo lives at the cwd. Reading CLAUDE.md and the
skills under .claude/skills/ for context is encouraged.

You have the full Claude Code toolset: Read, Glob, Grep, Bash, Edit,
Write, WebFetch. Mutating tofu commands (apply/destroy/import/state) are
denied by .claude/settings.json — if the user asks to apply, tell them to
run it manually in their shell.

When you change HCL, leave a brief note in chat about what you changed
and why. The UI will refresh the resource list and the Blueprint canvas
after any tool call, so the user can click resources to see the updated
state.

# Blueprint canvas

The user may have a "Blueprint" tab open in the middle pane — a visual
builder for OpenTofu resources. When the user asks you to *create*, *add*,
or *place* a resource (S3 bucket, EC2 instance, VPC, subnet, IAM role),
write the HCL as a one-resource-per-file `.tf` at the workspace root:

  live/blueprint/bp.<aws_type>.<name>.tf

For example, "create an S3 bucket called logs" maps to:

  live/blueprint/bp.aws_s3_bucket.logs.tf

  resource "aws_s3_bucket" "logs" {
    bucket = "my-app-logs"
  }

The Blueprint canvas reads the workspace root on every tool result, so
dropping a file there makes the resource appear automatically — no
manual refresh needed.

Conventions to follow:
- One resource per file, named `bp.<aws_type>.<name>.tf` at the workspace
  root (NOT a subdirectory — OpenTofu's root-module loader doesn't recurse,
  so files in a `resources/` subdir are invisible to `tofu plan`). The
  frontend parser splits the filename to recover (type, name) if the HCL
  fails to parse.
- For references between resources, use **bare** HCL expressions,
  not `${...}` interpolation. `vpc_id = aws_vpc.main.id`, not
  `vpc_id = "${aws_vpc.main.id}"`. The Blueprint backend derives
  dependency edges from these references.
- After writing, `tofu -chdir=live/blueprint validate` should pass.
  If it fails, fix the file before declaring done.

If the user asks "what's in my blueprint?" or similar, list the
`live/blueprint/bp.*.tf` files. To delete a resource, remove its
`bp.<type>.<name>.tf` file (and optionally its `_layout.json` entry)."""


@dataclass
class ChatEvent:
    kind: str  # "text" | "tool_use" | "tool_result" | "done" | "error"
    data: dict[str, Any]


def _messages_to_prompt(messages: list[dict[str, Any]]) -> str:
    """Replay browser-side history as a single prompt.

    Stateless on purpose — every request re-sends the full conversation.
    A per-session ClaudeSDKClient would be a v3 optimization.
    """
    if not messages:
        return ""
    lines: list[str] = []
    for m in messages[:-1]:
        label = "User" if m["role"] == "user" else "Assistant"
        lines.append(f"<{label} previously said>\n{m['content']}\n</{label}>")
    lines.append(messages[-1]["content"])
    return "\n\n".join(lines)


def _tool_summary(name: str, args: dict[str, Any]) -> str:
    # Render a short pill label for the UI. Best-effort per tool.
    if name == "Read":
        return str(args.get("file_path", ""))
    if name in ("Edit", "Write"):
        return str(args.get("file_path", ""))
    if name == "Bash":
        cmd = str(args.get("command", ""))
        return cmd if len(cmd) <= 60 else cmd[:57] + "…"
    if name in ("Grep", "Glob"):
        return str(args.get("pattern", ""))
    if name == "WebFetch":
        return str(args.get("url", ""))
    return ""


def _result_summary(content: Any) -> str:
    if content is None:
        return "ok"
    if isinstance(content, str):
        return _truncate(content)
    if isinstance(content, list) and content:
        # Tool result blocks may be a list of {type, text} dicts.
        first = content[0]
        if isinstance(first, dict) and "text" in first:
            return _truncate(str(first["text"]))
    return "ok"


def _truncate(s: str, limit: int = 80) -> str:
    s = s.strip().replace("\n", " ")
    return s if len(s) <= limit else s[: limit - 1] + "…"


def _events_from_message(msg: Any) -> list[ChatEvent]:
    """Map one SDK message to zero-or-more SSE events for the frontend."""
    out: list[ChatEvent] = []

    if isinstance(msg, StreamEvent):
        # Partial deltas: extract text_delta chunks from the raw event payload.
        event = msg.event
        if event.get("type") == "content_block_delta":
            delta = event.get("delta") or {}
            if delta.get("type") == "text_delta":
                text = delta.get("text") or ""
                if text:
                    out.append(ChatEvent("text", {"delta": text}))
        return out

    if isinstance(msg, AssistantMessage):
        for block in msg.content:
            if isinstance(block, ToolUseBlock):
                out.append(
                    ChatEvent(
                        "tool_use",
                        {
                            "id": block.id,
                            "name": block.name,
                            "input": block.input,
                            "summary": _tool_summary(block.name, block.input),
                        },
                    )
                )
            # We intentionally skip TextBlock here — full text already
            # arrived via StreamEvent deltas. Re-emitting would duplicate.
        return out

    if isinstance(msg, UserMessage):
        # Tool results land in the synthetic UserMessage that follows an
        # AssistantMessage with tool_use blocks.
        content = msg.content
        if isinstance(content, list):
            for block in content:
                if isinstance(block, ToolResultBlock):
                    out.append(
                        ChatEvent(
                            "tool_result",
                            {
                                "tool_use_id": block.tool_use_id,
                                "is_error": bool(block.is_error),
                                "summary": _result_summary(block.content),
                            },
                        )
                    )
        return out

    if isinstance(msg, ResultMessage):
        # ResultMessage marks end-of-turn with usage/cost info — we emit
        # 'done' from the outer loop instead so the stream closes cleanly.
        return out

    if isinstance(msg, SystemMessage):
        # Init handshakes etc. Ignore.
        return out

    return out


async def stream_chat(messages: list[dict[str, Any]]) -> AsyncIterator[ChatEvent]:
    settings = get_settings()
    if not settings.anthropic_api_key:
        yield ChatEvent("error", {"message": "ANTHROPIC_API_KEY is not set"})
        return

    options = ClaudeAgentOptions(
        cwd=str(settings.repo_root),
        model=settings.anthropic_model,
        # Inherit this repo's CLAUDE.md, .claude/settings.json (denies for
        # tofu apply/destroy/import), and the skills under .claude/skills/.
        setting_sources=["project"],
        # The UI has no permission dialog yet; the deny list above stays
        # in effect regardless of this setting.
        permission_mode="bypassPermissions",
        include_partial_messages=True,
        system_prompt={
            "type": "preset",
            "preset": "claude_code",
            "append": SYSTEM_PROMPT_APPEND,
        },
        max_turns=20,
        # Auto-load all locally-defined skills.
        skills="all",
    )

    prompt = _messages_to_prompt(messages)

    try:
        async for msg in query(prompt=prompt, options=options):
            for evt in _events_from_message(msg):
                yield evt
    except Exception as exc:
        yield ChatEvent("error", {"message": f"{type(exc).__name__}: {exc}"})
        return

    yield ChatEvent("done", {})
