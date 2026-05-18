"""Blueprint canvas routes.

The Blueprint tab in the UI is a visual builder for OpenTofu config.
Users drag resource tiles onto a canvas, and the form pane on the
right edits the resource's attributes. The HCL the canvas writes
lives in the workspace pointed at by `settings.blueprint_root`
(default: `live/blueprint/`).

This module owns:
- `GET /api/schemas` — returns the provider schema for the supported
  resource types so the form can render the right fields.

Future phases will add:
- `GET /api/blueprint/graph` — parsed canvas state from the workspace's
  HCL (nodes + dependency edges).
- `POST /api/blueprint/resource` — write a new resource block to HCL.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from ..settings import get_settings
from ..tofu import TofuError, providers_schema

router = APIRouter()

# The Blueprint MVP supports a curated set of AWS resource types. Each
# entry has a short friendly name + 2-letter monogram for the canvas
# tile, kept consistent with `frontend/lib/resourceFamilies.ts` so the
# Blueprint and List views read the same visual language.
SUPPORTED_TYPES: dict[str, dict[str, str]] = {
    "aws_s3_bucket": {"label": "S3 bucket", "family": "storage"},
    "aws_instance": {"label": "EC2 instance", "family": "compute"},
    "aws_vpc": {"label": "VPC", "family": "network"},
    "aws_subnet": {"label": "Subnet", "family": "network"},
    "aws_iam_role": {"label": "IAM role", "family": "iam"},
}

# OpenTofu and Terraform serve the AWS provider under different registry
# hostnames in the `providers schema -json` output. We try OpenTofu's
# key first since this repo is OpenTofu-native, and fall back to the
# Terraform Registry key so the same backend works in a Terraform shop.
AWS_PROVIDER_KEYS = (
    "registry.opentofu.org/hashicorp/aws",
    "registry.terraform.io/hashicorp/aws",
)


@router.get("/schemas")
def schemas(
    types: list[str] = Query(default=None),
) -> dict[str, Any]:
    """Returns the resource schemas the Blueprint UI needs to render
    the param form for each supported type.

    By default returns all `SUPPORTED_TYPES`; pass `?types=aws_s3_bucket&types=...`
    to filter. Each returned entry has the attribute schema (name +
    type + required + description) and the nested `block_types` for
    blocks like `versioning` or `lifecycle_rule`.
    """
    settings = get_settings()
    requested = list(types) if types else list(SUPPORTED_TYPES.keys())

    # Reject unknown types up-front rather than 500'ing later when the
    # schema lookup misses.
    unknown = [t for t in requested if t not in SUPPORTED_TYPES]
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported resource types: {', '.join(unknown)}",
        )

    try:
        schema = providers_schema(settings.blueprint_root)
    except TofuError as exc:
        raise HTTPException(
            status_code=500,
            detail=(
                f"{exc}\n\nHint: the Blueprint workspace at "
                f"{settings.blueprint_root} may need `tofu init`."
            ),
        ) from exc

    provider_schemas = schema.get("provider_schemas") or {}
    provider_block: dict[str, Any] = {}
    provider_key_used = ""
    for key in AWS_PROVIDER_KEYS:
        if key in provider_schemas:
            provider_block = provider_schemas[key]
            provider_key_used = key
            break
    resources_block = provider_block.get("resource_schemas") or {}

    out: dict[str, Any] = {}
    for t in requested:
        meta = SUPPORTED_TYPES[t]
        resource_schema = resources_block.get(t)
        if resource_schema is None:
            # The provider exists but doesn't have this resource type.
            # Skip rather than failing the whole request.
            continue
        block = resource_schema.get("block") or {}
        out[t] = {
            "label": meta["label"],
            "family": meta["family"],
            "attributes": _normalize_attributes(block.get("attributes") or {}),
            "block_types": _normalize_block_types(block.get("block_types") or {}),
        }

    return {
        "blueprint_root": str(settings.blueprint_root),
        "provider": provider_key_used,
        "resources": out,
    }


def _normalize_attributes(attrs: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten the provider-schema attribute map into a list the
    frontend form can render directly. Keeps only the fields the UI
    cares about; drops sensitive computed-only attributes the user
    can't set."""
    out: list[dict[str, Any]] = []
    for name, info in attrs.items():
        # `computed_only` attributes (e.g., `arn`, `id`) are surfaced
        # in the resource state, not authored by the user — skip.
        if info.get("computed") and not info.get("optional") and not info.get(
            "required"
        ):
            continue
        out.append(
            {
                "name": name,
                "type": info.get("type"),
                "description": info.get("description") or "",
                "required": bool(info.get("required")),
                "optional": bool(info.get("optional")),
                "sensitive": bool(info.get("sensitive")),
                "deprecated": bool(info.get("deprecated")),
            }
        )
    # Required first, then alphabetical. The frontend can re-sort.
    out.sort(key=lambda a: (not a["required"], a["name"]))
    return out


def _normalize_block_types(block_types: dict[str, Any]) -> list[dict[str, Any]]:
    """Same shape as `_normalize_attributes` but for nested blocks
    (`versioning { ... }`, `lifecycle_rule { ... }`, etc.). We surface
    them at one level deep so the form can render a 'configure block'
    button per nested type; full deep-tree handling is a follow-up."""
    out: list[dict[str, Any]] = []
    for name, info in block_types.items():
        nesting = info.get("nesting_mode") or ""
        block = info.get("block") or {}
        attr_count = len(block.get("attributes") or {})
        nested_count = len(block.get("block_types") or {})
        out.append(
            {
                "name": name,
                "nesting_mode": nesting,
                "description": info.get("description") or block.get("description") or "",
                "min_items": info.get("min_items") or 0,
                "max_items": info.get("max_items") or 0,
                "attribute_count": attr_count,
                "nested_block_count": nested_count,
            }
        )
    out.sort(key=lambda b: b["name"])
    return out
