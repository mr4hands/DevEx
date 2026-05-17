"""Chat route — Server-Sent Events stream from the Claude tool-use loop."""

from __future__ import annotations

import json
from typing import Any, Literal

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..agent import stream_chat

router = APIRouter()


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(default_factory=list)


def _sse(event: str, payload: dict[str, Any]) -> str:
    # Two-line frame: `event:` + `data:` then a blank line.
    return f"event: {event}\ndata: {json.dumps(payload)}\n\n"


@router.post("/chat")
async def chat(req: ChatRequest) -> StreamingResponse:
    convo = [{"role": m.role, "content": m.content} for m in req.messages]

    async def gen():
        async for evt in stream_chat(convo):
            yield _sse(evt.kind, evt.data)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable proxy buffering if any
        },
    )
