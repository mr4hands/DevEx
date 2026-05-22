"""Leaf path math, coord validation, and per-leaf boilerplate for the
devex-live overlay. A leaf is account/region/layer/component."""

from __future__ import annotations

import re

# Path segments become directory names, so they must be safe path components:
# lowercase letters, digits, hyphens; no separators, dots, or spaces.
_COORD_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def validate_coord(value: str) -> str:
    if not _COORD_RE.fullmatch(value):
        raise ValueError(
            f"Invalid coord {value!r}: 1-64 chars, lowercase/digits/hyphen, "
            "no separators or dots."
        )
    return value


def leaf_relpath(account: str, region: str, layer: str, component: str) -> str:
    parts = [
        validate_coord(account),
        validate_coord(region),
        validate_coord(layer),
        validate_coord(component),
    ]
    return "/".join(parts)
