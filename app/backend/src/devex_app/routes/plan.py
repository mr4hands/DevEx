"""Plan/state inspection routes.

`GET /api/plan` — current state from `tofu show -json`, grouped by type.
`GET /api/plan-diff` — pending changes from `tofu plan -out` + `tofu show
-json <planfile>`, normalized into a list of `ResourceChange` items with
action category and before/after payloads. Used by the UI's Plan tab.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any

from fastapi import APIRouter, HTTPException

from ..settings import get_settings
from ..tofu import (
    TofuError,
    changes_from_plan,
    plan_diff,
    resources_from_state,
    show_state,
)

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


@router.get("/plan-diff")
def plan_diff_route() -> dict[str, Any]:
    """Run `tofu plan` and return the planned changes.

    Slow (5-30s real, faster against Moto). Read-only — never applies.
    """
    settings = get_settings()
    try:
        raw_plan = plan_diff(settings.tofu_root)
    except TofuError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    changes = changes_from_plan(raw_plan)
    # Drop true no-ops (refresh-only nudges) from the surfaced list. These
    # are typically tag-system or provider-internal reconciliations the
    # user doesn't act on; keeping them in the totals (`counts`) gives the
    # full picture without UI noise.
    visible = [c for c in changes if c.action_kind not in {"no-op", "read"}]

    counts = Counter(c.action_kind for c in changes)

    return {
        "tofu_root": str(settings.tofu_root),
        "terraform_version": raw_plan.get("terraform_version"),
        "format_version": raw_plan.get("format_version"),
        "total_changes": len(changes),
        "visible_changes": len(visible),
        "counts": dict(counts),
        "changes": [
            {
                "address": c.address,
                "type": c.type,
                "name": c.name,
                "module": c.module,
                "provider": c.provider,
                "mode": c.mode,
                "actions": c.actions,
                "action_kind": c.action_kind,
                "importing_id": c.importing_id,
                "before": c.before,
                "after": c.after,
            }
            for c in visible
        ],
    }
