"""Existing-resource discovery routes.

`GET /api/existing-resources` serves the discovery manifest a Claude
agent skill writes to `live/blueprint/_discovered.json`. This endpoint is
deterministic — it never invokes an LLM or shells out. The agent fills the
manifest (whole tree or one branch); this serves whatever is there.

Manifest shape:
    {
      "source": "aws",
      "generated_at": "<iso8601>",
      "scopes_loaded": ["aws_s3_bucket", ...],
      "groups": [ { "type": "aws_s3_bucket", "resources": [
          { "address", "type", "name", "import_id", "summary_attributes" } ] } ]
    }
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Query

from ..settings import get_settings

router = APIRouter()

MANIFEST_FILENAME = "_discovered.json"

_DISCOVERY_HINT = (
    "No discovery manifest yet. Ask the agent to discover AWS resources "
    "(it runs the aws-resource-discovery skill and writes _discovered.json)."
)


@router.get("/existing-resources")
def existing_resources(
    scope: str | None = Query(
        default=None,
        description="Optional resource type to filter to a single branch.",
    ),
) -> dict[str, Any]:
    """Serve the discovery manifest. Missing or malformed manifests
    degrade to an empty result with a hint/error rather than a 500, so a
    cold or corrupt file never breaks the tree."""
    settings = get_settings()
    path = settings.blueprint_root / MANIFEST_FILENAME

    empty: dict[str, Any] = {
        "source": None,
        "generated_at": None,
        "scopes_loaded": [],
        "groups": [],
    }
    if not path.exists():
        return {**empty, "hint": _DISCOVERY_HINT}

    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return {**empty, "error": f"Malformed discovery manifest: {exc}"}

    groups = manifest.get("groups") or []
    if scope:
        groups = [g for g in groups if g.get("type") == scope]

    return {
        "source": manifest.get("source"),
        "generated_at": manifest.get("generated_at"),
        "scopes_loaded": manifest.get("scopes_loaded") or [],
        "groups": groups,
    }
