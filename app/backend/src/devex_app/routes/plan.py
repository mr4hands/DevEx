"""Plan/state inspection route.

`GET /api/plan` returns the parsed `tofu show -json` payload from the
configured root, normalized into a flat resource list grouped by type and
module. v1 surfaces the current state; a future endpoint can surface a
saved `-out` planfile so the UI can show pre-apply diffs.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from fastapi import APIRouter, HTTPException

from ..settings import get_settings
from ..tofu import TofuError, resources_from_state, show_state

router = APIRouter()


@router.get("/plan")
def plan() -> dict[str, Any]:
    settings = get_settings()
    try:
        state = show_state(settings.tofu_root)
    except TofuError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    resources = resources_from_state(state)
    by_type: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in resources:
        by_type[r.type].append(
            {
                "address": r.address,
                "type": r.type,
                "name": r.name,
                "module": r.module,
                "mode": r.mode,
                "provider": r.provider,
                "values": r.values,
            }
        )

    return {
        "tofu_root": str(settings.tofu_root),
        "terraform_version": state.get("terraform_version"),
        "format_version": state.get("format_version"),
        "resource_count": len(resources),
        "groups": [
            {"type": t, "resources": items} for t, items in sorted(by_type.items())
        ],
    }
