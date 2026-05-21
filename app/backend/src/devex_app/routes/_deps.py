"""Shared FastAPI dependencies."""

from __future__ import annotations

from fastapi import Header

from ..settings import get_settings


def resolve_owner(
    x_devex_owner: str | None = Header(default=None),
) -> str:
    """The developer whose draft namespace this request operates on. Comes
    from the `X-DevEx-Owner` header; falls back to the configured default
    owner until real identity/auth lands."""
    owner = (x_devex_owner or "").strip()
    return owner or get_settings().default_owner
