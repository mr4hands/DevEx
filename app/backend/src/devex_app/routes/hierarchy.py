"""Hierarchy mapping CRUD — the component-override layer.

Persists `live/blueprint/_hierarchy.json`:

    {
      "components": { "<name>": {"display_name": ..., "target_module": ...} },
      "overrides":  { "<resource address>": "<component>" }
    }

The inventory route reads this file; setting an override here reclassifies
the resource on the next `/api/inventory` call. Components are created on
the fly when an override names one that doesn't exist yet.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..settings import get_settings

router = APIRouter()

_HIERARCHY = "_hierarchy.json"


def _path() -> Path:
    return get_settings().blueprint_root / _HIERARCHY


def _load() -> dict[str, Any]:
    path = _path()
    if not path.exists():
        return {"components": {}, "overrides": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"components": {}, "overrides": {}}
    data.setdefault("components", {})
    data.setdefault("overrides", {})
    return data


def _save(data: dict[str, Any]) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    tmp.replace(path)


@router.get("/hierarchy")
def get_hierarchy() -> dict[str, Any]:
    return _load()


class OverrideRequest(BaseModel):
    address: str = Field(..., min_length=1, description="Resource address")
    component: str = Field(..., min_length=1, description="Component to assign")


@router.put("/hierarchy/override")
def set_override(req: OverrideRequest) -> dict[str, Any]:
    data = _load()
    data["overrides"][req.address] = req.component
    # Create the component on the fly if it's new (Unassigned is a virtual
    # bucket, never a real component).
    if req.component != "Unassigned" and req.component not in data["components"]:
        slug = req.component.lower().replace(" ", "_")
        data["components"][req.component] = {
            "display_name": req.component,
            "target_module": f"modules/{slug}",
        }
    _save(data)
    return data


class ClearOverrideRequest(BaseModel):
    address: str = Field(..., min_length=1)


@router.post("/hierarchy/override/clear")
def clear_override(req: ClearOverrideRequest) -> dict[str, Any]:
    data = _load()
    data["overrides"].pop(req.address, None)
    _save(data)
    return data
