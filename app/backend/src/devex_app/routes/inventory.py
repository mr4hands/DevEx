"""Unified inventory route.

`GET /api/inventory` merges managed resources (tofu state) with unmanaged
resources (the AWS discovery manifest), dedups by id, and classifies each
by account/region/component. Returns a flat list — the frontend groups it
into the Account -> Region -> Component -> type -> resource tree.
Read-only and deterministic.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter

from ..inventory import account_region, classify_component
from ..settings import get_settings
from ..tofu import TofuError, resources_from_state, show_state

router = APIRouter()

_MANIFEST = "_discovered.json"
_HIERARCHY = "_hierarchy.json"


def _load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


@router.get("/inventory")
def inventory() -> dict[str, Any]:
    settings = get_settings()

    hierarchy = _load_json(settings.blueprint_root / _HIERARCHY)
    overrides: dict[str, str] = hierarchy.get("overrides") or {}
    components: dict[str, Any] = hierarchy.get("components") or {}

    items: dict[str, dict[str, Any]] = {}

    # Managed resources from tofu state — full attributes.
    try:
        managed = resources_from_state(show_state(settings.tofu_root))
    except TofuError:
        managed = []
    for r in managed:
        tags = r.values.get("tags") or {}
        component, source = classify_component(tags, r.address, overrides)
        account, region = account_region(r.values)
        key = r.values.get("id") or r.values.get("arn") or r.address
        items[key] = {
            "address": r.address,
            "type": r.type,
            "name": r.name,
            "id": r.values.get("id"),
            "arn": r.values.get("arn"),
            "account": account,
            "region": region,
            "managed": True,
            "component": component,
            "component_source": source,
            "tags": tags,
            "values": r.values,
        }

    # Unmanaged resources from the discovery manifest.
    manifest = _load_json(settings.blueprint_root / _MANIFEST)
    for group in manifest.get("groups") or []:
        for res in group.get("resources") or []:
            summary = res.get("summary_attributes") or {}
            key = res.get("import_id") or summary.get("arn") or res.get("address")
            if key in items:
                continue  # managed wins
            tags = summary.get("tags") or {}
            address = res.get("address") or f"{res.get('type')}.{res.get('name')}"
            component, source = classify_component(tags, address, overrides)
            account, region = account_region(summary)
            items[key] = {
                "address": address,
                "type": res.get("type"),
                "name": res.get("name"),
                "id": res.get("import_id"),
                "arn": summary.get("arn"),
                "account": account,
                "region": region,
                "managed": False,
                "component": component,
                "component_source": source,
                "tags": tags,
                "values": summary,
            }

    return {"resources": list(items.values()), "components": components}
