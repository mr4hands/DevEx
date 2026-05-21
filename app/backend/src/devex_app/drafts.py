"""Per-owner draft storage for the inspector-centric CRUD model.

Each developer's pending changes live under
`<blueprint_root>/drafts/<owner>/`:
  - `bp.<type>.<name>.tf`  — the draft's HCL (for new/adopt/edit)
  - `_drafts.json`         — `{ "<address>": {kind, owner, ...} }`

Owner namespacing keeps concurrent developers from clobbering each other.
This module is pure storage; HCL rendering lives in routes/blueprint.py.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_DRAFTS_FILE = "_drafts.json"


def owner_dir(blueprint_root: Path, owner: str) -> Path:
    return blueprint_root / "drafts" / owner


def _drafts_path(blueprint_root: Path, owner: str) -> Path:
    return owner_dir(blueprint_root, owner) / _DRAFTS_FILE


def load_drafts(blueprint_root: Path, owner: str) -> dict[str, Any]:
    path = _drafts_path(blueprint_root, owner)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _write_drafts(blueprint_root: Path, owner: str, data: dict[str, Any]) -> None:
    path = _drafts_path(blueprint_root, owner)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    tmp.replace(path)


def save_draft_entry(
    blueprint_root: Path, owner: str, address: str, entry: dict[str, Any]
) -> None:
    data = load_drafts(blueprint_root, owner)
    data[address] = entry
    _write_drafts(blueprint_root, owner, data)


def delete_draft_entry(blueprint_root: Path, owner: str, address: str) -> None:
    data = load_drafts(blueprint_root, owner)
    if address in data:
        del data[address]
        _write_drafts(blueprint_root, owner, data)
