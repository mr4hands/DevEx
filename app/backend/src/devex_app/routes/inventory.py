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

from fastapi import APIRouter, Depends

from .. import drafts
from ..inventory import account_region, classify_component
from ..settings import get_settings
from ..tofu import TofuError, resources_from_state, show_state
from ._deps import resolve_owner
from .blueprint import _parse_resource_file, list_resources

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
def inventory(owner: str = Depends(resolve_owner)) -> dict[str, Any]:
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
            "state": "managed",
            "draft_kind": None,
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
                "state": "unmanaged",
                "draft_kind": None,
                "component": component,
                "component_source": source,
                "tags": tags,
                "values": summary,
            }

    # Planned resources authored in the blueprint sandbox (bp.*.tf) — not
    # yet applied or discovered, but classified by their Component tag so a
    # just-added resource shows under its component immediately.
    sandbox_account = hierarchy.get("account_id") or "unknown"
    sandbox_region = hierarchy.get("region") or "unknown"
    for res in (list_resources().get("resources") or []):
        address = f"{res['type']}.{res['name']}"
        import_id = res.get("import_id")
        key = import_id or f"bp:{address}"
        if key in items:
            continue
        attrs = res.get("attributes") or {}
        tags = attrs.get("tags") or {}
        component, source = classify_component(tags, address, overrides)
        account, region = account_region(attrs)
        if account == "unknown":
            account = sandbox_account
        if region == "unknown":
            region = sandbox_region
        items[key] = {
            "address": address,
            "type": res["type"],
            "name": res["name"],
            "id": import_id,
            "arn": attrs.get("arn"),
            "account": account,
            "region": region,
            "managed": False,
            "state": "planned",
            "draft_kind": None,
            "component": component,
            "component_source": source,
            "tags": tags,
            "values": attrs,
        }

    # Overlay the requesting owner's drafts. `edit`/`delete` drafts annotate
    # an existing live row; `new`/`adopt` drafts have no live counterpart, so
    # surface them as their own `planned` rows (reading their HCL from the
    # owner's draft namespace) so a just-created resource shows in the tree.
    owner_drafts = drafts.load_drafts(settings.blueprint_root, owner)
    owner_root = drafts.owner_dir(settings.blueprint_root, owner)
    by_address = {it["address"]: it for it in items.values()}
    for address, entry in owner_drafts.items():
        target = by_address.get(address)
        if target is not None:
            target["draft_kind"] = entry.get("kind")
            continue
        kind = entry.get("kind")
        if kind not in ("new", "adopt"):
            continue
        type_, _, name = address.partition(".")
        attrs: dict[str, Any] = {}
        bp_path = owner_root / f"bp.{type_}.{name}.tf"
        if bp_path.exists():
            try:
                parsed = _parse_resource_file(bp_path)
                if parsed:
                    attrs = parsed.get("attributes") or {}
            except Exception:  # noqa: BLE001 — a bad draft file shouldn't 500
                attrs = {}
        tags = attrs.get("tags") or {}
        component, source = classify_component(tags, address, overrides)
        if component == "Unassigned" and entry.get("component"):
            component, source = str(entry["component"]), "tag"
        items[f"draft:{address}"] = {
            "address": address,
            "type": type_,
            "name": name,
            "id": None,
            "arn": attrs.get("arn"),
            "account": sandbox_account,
            "region": sandbox_region,
            "managed": False,
            "state": "planned",
            "draft_kind": kind,
            "component": component,
            "component_source": source,
            "tags": tags,
            "values": attrs,
        }

    return {"resources": list(items.values()), "components": components}
