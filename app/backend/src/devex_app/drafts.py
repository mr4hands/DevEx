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
import threading
from pathlib import Path
from typing import Any

_DRAFTS_FILE = "_drafts.json"

# Per-owner locks serialize the load→mutate→write of `_drafts.json` so two
# concurrent same-owner requests (Starlette runs sync handlers in a thread
# pool) can't lose each other's entries. In-process only — full
# multi-process safety is part of the deferred production work.
_owner_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _owner_lock(blueprint_root: Path, owner: str) -> threading.Lock:
    key = str(owner_dir(blueprint_root, owner))
    with _locks_guard:
        return _owner_locks.setdefault(key, threading.Lock())


def owner_dir(blueprint_root: Path, owner: str) -> Path:
    """Resolved per-owner draft directory. Defense-in-depth: refuse a path
    that escapes the blueprint root (the route layer already validates the
    owner header, but this guards any other caller)."""
    base = blueprint_root.resolve()
    candidate = (base / "drafts" / owner).resolve()
    if base != candidate and base not in candidate.parents:
        raise ValueError(f"owner {owner!r} escapes blueprint root")
    return candidate


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
    with _owner_lock(blueprint_root, owner):
        data = load_drafts(blueprint_root, owner)
        data[address] = entry
        _write_drafts(blueprint_root, owner, data)


def delete_draft_entry(blueprint_root: Path, owner: str, address: str) -> None:
    with _owner_lock(blueprint_root, owner):
        data = load_drafts(blueprint_root, owner)
        if address in data:
            del data[address]
            _write_drafts(blueprint_root, owner, data)
