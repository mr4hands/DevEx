"""Shared FastAPI dependencies."""

from __future__ import annotations

import re

from fastapi import Header, HTTPException

from ..settings import get_settings

# The owner becomes a directory name (`drafts/<owner>/`), so it must be a
# safe path component — no separators, no `.`/`..`, no leading dot/dash.
# This blocks path traversal via the client-supplied `X-DevEx-Owner` header.
_OWNER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def resolve_owner(
    x_devex_owner: str | None = Header(default=None),
) -> str:
    """The developer whose draft namespace this request operates on. Comes
    from the `X-DevEx-Owner` header; falls back to the configured default
    owner until real identity/auth lands. Rejected with 400 if the value
    isn't a safe path component."""
    owner = (x_devex_owner or "").strip() or get_settings().default_owner
    if not _OWNER_RE.fullmatch(owner):
        raise HTTPException(status_code=400, detail=f"Invalid owner {owner!r}")
    return owner
