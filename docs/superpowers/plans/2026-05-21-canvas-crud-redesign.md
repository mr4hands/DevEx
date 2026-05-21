# Inspector-centric CRUD Redesign — Implementation Plan (Phase 1: owner-scoped draft backend)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the owner-scoped draft backend — a `POST/DELETE /api/blueprint/draft` API that records create/adopt/edit/delete drafts per developer, and an inventory overlay so each owner sees their own pending changes.

**Architecture:** Each developer's drafts live in a per-owner namespace (`live/blueprint/drafts/<owner>/`: `bp.*.tf` + `_drafts.json`). Owner comes from an `X-DevEx-Owner` header (default configurable). The inventory route overlays the requesting owner's drafts onto the shared live + discovered inventory, annotating each resource with its draft kind (and seeded attrs for edits). Deterministic, no AWS.

**Tech Stack:** FastAPI + pydantic, pytest + httpx `TestClient`.

**Reference spec:** `docs/superpowers/specs/2026-05-21-canvas-crud-redesign-design.md`

**Scope note:** Phase 1 of 4. Phases 2 (unified `Inspector` UI), 3 (QuickCreate + delete UI + pending-changes bar), 4 (per-owner promote routing + retire old drawers) get their own plans. This phase is **additive** — it does not change the existing flat-sandbox `/api/blueprint/resource` endpoints or the canvas; the draft namespace is new. Reconciling the canvas onto drafts is Phase 4.

**Conventions:** backend pkg `devex_app` (editable); run `./.venv/bin/python -m pytest` from `app/backend`. Tests override settings via env + `get_settings.cache_clear()` (see `tests/conftest.py`). Reuses existing helpers in `routes/blueprint.py`: `_render_resource_block`, `_render_import_block`, `_read_only_attr_names`, `_parse_resource_file`, `_DELETE_TYPE_RE`, `_NAME_RE`.

---

## Task 1: Configurable default owner

**Files:**
- Modify: `app/backend/src/devex_app/settings.py`
- Test: `app/backend/tests/test_owner.py`

- [ ] **Step 1: Write the failing test**

`app/backend/tests/test_owner.py`:

```python
from __future__ import annotations


def test_default_owner_from_env(tmp_path, monkeypatch):
    monkeypatch.setenv("REPO_ROOT", str(tmp_path))
    monkeypatch.setenv("DEVEX_OWNER", "alice")
    from devex_app.settings import get_settings

    get_settings.cache_clear()
    assert get_settings().default_owner == "alice"
    get_settings.cache_clear()


def test_default_owner_fallback(tmp_path, monkeypatch):
    monkeypatch.setenv("REPO_ROOT", str(tmp_path))
    monkeypatch.delenv("DEVEX_OWNER", raising=False)
    from devex_app.settings import get_settings

    get_settings.cache_clear()
    assert get_settings().default_owner == "local"
    get_settings.cache_clear()
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app/backend && ./.venv/bin/python -m pytest tests/test_owner.py -v`
Expected: FAIL — `Settings` has no `default_owner`.

- [ ] **Step 3: Add `default_owner` to Settings**

In `app/backend/src/devex_app/settings.py`, add the field to `__init__` (new
param `default_owner: str`, stored as `self.default_owner = default_owner`)
and in `from_env` add:

```python
        default_owner=os.environ.get("DEVEX_OWNER", "local"),
```

passing it into the `cls(...)` call. Update the `__init__` signature:

```python
    def __init__(
        self,
        *,
        anthropic_api_key: str | None,
        anthropic_model: str,
        repo_root: Path,
        tofu_root: Path,
        blueprint_root: Path,
        default_owner: str,
    ) -> None:
        ...
        self.default_owner = default_owner
```

- [ ] **Step 4: Run to verify pass**

Run: `cd app/backend && ./.venv/bin/python -m pytest tests/test_owner.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/backend/src/devex_app/settings.py app/backend/tests/test_owner.py
git commit -m "feat(app): configurable default owner (DEVEX_OWNER)"
```

---

## Task 2: Per-owner draft storage module

**Files:**
- Create: `app/backend/src/devex_app/drafts.py`
- Test: `app/backend/tests/test_drafts_store.py`

- [ ] **Step 1: Write the failing tests**

`app/backend/tests/test_drafts_store.py`:

```python
from __future__ import annotations

from pathlib import Path

from devex_app import drafts


def test_owner_dir_is_namespaced(tmp_path):
    d = drafts.owner_dir(tmp_path, "alice")
    assert d == tmp_path / "drafts" / "alice"


def test_save_and_load_draft(tmp_path):
    drafts.save_draft_entry(
        tmp_path, "alice", "aws_s3_bucket.logs", {"kind": "new", "owner": "alice"}
    )
    loaded = drafts.load_drafts(tmp_path, "alice")
    assert loaded["aws_s3_bucket.logs"]["kind"] == "new"
    # Different owner is isolated.
    assert drafts.load_drafts(tmp_path, "bob") == {}


def test_delete_draft_entry(tmp_path):
    drafts.save_draft_entry(tmp_path, "alice", "aws_vpc.main", {"kind": "edit"})
    drafts.delete_draft_entry(tmp_path, "alice", "aws_vpc.main")
    assert drafts.load_drafts(tmp_path, "alice") == {}


def test_malformed_drafts_file_is_ignored(tmp_path):
    d = drafts.owner_dir(tmp_path, "alice")
    d.mkdir(parents=True)
    (d / "_drafts.json").write_text("{not json")
    assert drafts.load_drafts(tmp_path, "alice") == {}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app/backend && ./.venv/bin/python -m pytest tests/test_drafts_store.py -v`
Expected: FAIL — `No module named 'devex_app.drafts'`.

- [ ] **Step 3: Implement the storage module**

`app/backend/src/devex_app/drafts.py`:

```python
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
```

- [ ] **Step 4: Run to verify pass**

Run: `cd app/backend && ./.venv/bin/python -m pytest tests/test_drafts_store.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/backend/src/devex_app/drafts.py app/backend/tests/test_drafts_store.py
git commit -m "feat(app): per-owner draft storage module"
```

---

## Task 3: Owner resolution dependency

**Files:**
- Create: `app/backend/src/devex_app/routes/_deps.py`
- Test: `app/backend/tests/test_owner_dep.py`

- [ ] **Step 1: Write the failing test**

`app/backend/tests/test_owner_dep.py`:

```python
from __future__ import annotations

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from devex_app.routes._deps import resolve_owner


def _app():
    app = FastAPI()

    @app.get("/whoami")
    def whoami(owner: str = Depends(resolve_owner)) -> dict[str, str]:
        return {"owner": owner}

    return app


def test_owner_from_header(blueprint_env):
    c = TestClient(_app())
    r = c.get("/whoami", headers={"X-DevEx-Owner": "alice"})
    assert r.json() == {"owner": "alice"}


def test_owner_defaults(blueprint_env):
    c = TestClient(_app())
    r = c.get("/whoami")
    assert r.json() == {"owner": "local"}  # DEVEX_OWNER default
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app/backend && ./.venv/bin/python -m pytest tests/test_owner_dep.py -v`
Expected: FAIL — `No module named 'devex_app.routes._deps'`.

- [ ] **Step 3: Implement the dependency**

`app/backend/src/devex_app/routes/_deps.py`:

```python
"""Shared FastAPI dependencies."""

from __future__ import annotations

from fastapi import Header

from ..settings import get_settings


def resolve_owner(
    x_devex_owner: str | None = Header(default=None),
) -> str:
    """The developer whose draft namespace this request operates on. Comes
    from the `X-DevEx-Owner` header; falls back to the configured default
    owner until real identity/auth lands."""
    owner = (x_devex_owner or "").strip()
    return owner or get_settings().default_owner
```

- [ ] **Step 4: Run to verify pass**

Run: `cd app/backend && ./.venv/bin/python -m pytest tests/test_owner_dep.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/backend/src/devex_app/routes/_deps.py app/backend/tests/test_owner_dep.py
git commit -m "feat(app): X-DevEx-Owner resolution dependency"
```

---

## Task 4: Draft CRUD endpoints

**Files:**
- Modify: `app/backend/src/devex_app/routes/blueprint.py`
- Test: `app/backend/tests/test_draft_routes.py`

- [ ] **Step 1: Write the failing tests**

`app/backend/tests/test_draft_routes.py`:

```python
from __future__ import annotations

import devex_app.routes.blueprint as bp
from devex_app import drafts

_SCHEMA = {
    "provider_schemas": {
        "registry.opentofu.org/hashicorp/aws": {
            "resource_schemas": {
                "aws_s3_bucket": {
                    "block": {
                        "attributes": {
                            "bucket": {"type": "string", "optional": True, "computed": True},
                            "arn": {"type": "string", "computed": True},
                        },
                        "block_types": {},
                    }
                }
            }
        }
    }
}


def test_new_draft_writes_file_and_entry(client, blueprint_env, monkeypatch):
    monkeypatch.setattr(bp, "providers_schema", lambda root: _SCHEMA)
    res = client.post(
        "/api/blueprint/draft",
        headers={"X-DevEx-Owner": "alice"},
        json={
            "kind": "new",
            "type": "aws_s3_bucket",
            "name": "logs",
            "component": "solr",
            "attributes": {"bucket": "acme-logs"},
        },
    )
    assert res.status_code == 200
    hcl = res.json()["hcl"]
    assert 'Component = "solr"' in hcl
    assert "acme-logs" in hcl
    # Owner-namespaced file + entry.
    owner = blueprint_env / "drafts" / "alice"
    assert (owner / "bp.aws_s3_bucket.logs.tf").exists()
    entry = drafts.load_drafts(blueprint_env, "alice")["aws_s3_bucket.logs"]
    assert entry["kind"] == "new" and entry["owner"] == "alice"


def test_adopt_draft_has_import_block(client, blueprint_env, monkeypatch):
    monkeypatch.setattr(bp, "providers_schema", lambda root: _SCHEMA)
    res = client.post(
        "/api/blueprint/draft",
        headers={"X-DevEx-Owner": "alice"},
        json={
            "kind": "adopt",
            "type": "aws_s3_bucket",
            "name": "old",
            "import_id": "old-bucket",
            "attributes": {"bucket": "old-bucket", "arn": "arn:aws:s3:::old-bucket"},
        },
    )
    hcl = res.json()["hcl"]
    assert "import {" in hcl and 'id = "old-bucket"' in hcl
    assert "arn" not in hcl  # read-only stripped


def test_delete_draft_records_marker_only(client, blueprint_env):
    res = client.post(
        "/api/blueprint/draft",
        headers={"X-DevEx-Owner": "alice"},
        json={
            "kind": "delete",
            "type": "aws_vpc",
            "name": "main",
            "source_address": "aws_vpc.main",
        },
    )
    assert res.status_code == 200
    owner = blueprint_env / "drafts" / "alice"
    assert not (owner / "bp.aws_vpc.main.tf").exists()
    assert drafts.load_drafts(blueprint_env, "alice")["aws_vpc.main"]["kind"] == "delete"


def test_discard_draft(client, blueprint_env, monkeypatch):
    monkeypatch.setattr(bp, "providers_schema", lambda root: _SCHEMA)
    client.post(
        "/api/blueprint/draft",
        headers={"X-DevEx-Owner": "alice"},
        json={"kind": "new", "type": "aws_s3_bucket", "name": "logs", "attributes": {}},
    )
    res = client.request(
        "DELETE",
        "/api/blueprint/draft/aws_s3_bucket/logs",
        headers={"X-DevEx-Owner": "alice"},
    )
    assert res.status_code == 200
    assert drafts.load_drafts(blueprint_env, "alice") == {}
    assert not (blueprint_env / "drafts" / "alice" / "bp.aws_s3_bucket.logs.tf").exists()


def test_owners_are_isolated(client, blueprint_env, monkeypatch):
    monkeypatch.setattr(bp, "providers_schema", lambda root: _SCHEMA)
    client.post(
        "/api/blueprint/draft",
        headers={"X-DevEx-Owner": "alice"},
        json={"kind": "new", "type": "aws_s3_bucket", "name": "logs", "attributes": {}},
    )
    assert drafts.load_drafts(blueprint_env, "bob") == {}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app/backend && ./.venv/bin/python -m pytest tests/test_draft_routes.py -v`
Expected: FAIL — 404 (route not registered).

- [ ] **Step 3: Implement the draft endpoints**

In `app/backend/src/devex_app/routes/blueprint.py`, add the imports at the
top with the others:

```python
from .. import drafts
from ._deps import resolve_owner
from fastapi import Depends
```

(Merge `Depends` into the existing `from fastapi import ...` line rather
than duplicating.)

Add near the other routes:

```python
class DraftRequest(BaseModel):
    """Body of POST /api/blueprint/draft. `kind` selects the change type;
    `attributes`/`import_id` seed the HCL for new/adopt/edit; `delete`
    records a marker only."""

    kind: str = Field(..., description="new | adopt | edit | delete")
    type: str = Field(...)
    name: str = Field(...)
    component: str | None = None
    source_address: str | None = None
    import_id: str | None = None
    attributes: dict[str, Any] = Field(default_factory=dict)

    @field_validator("kind")
    @classmethod
    def _kind_valid(cls, v: str) -> str:
        if v not in {"new", "adopt", "edit", "delete"}:
            raise ValueError(f"Invalid draft kind {v!r}")
        return v

    @field_validator("type")
    @classmethod
    def _type_valid(cls, v: str) -> str:
        if not _DELETE_TYPE_RE.match(v):
            raise ValueError(f"Invalid resource type {v!r}")
        return v

    @field_validator("name")
    @classmethod
    def _name_valid(cls, v: str) -> str:
        if not _NAME_RE.match(v):
            raise ValueError(f"Invalid resource name {v!r}")
        return v


def _component_target_module(component: str | None) -> str | None:
    if not component:
        return None
    slug = component.lower().replace(" ", "_")
    return f"modules/{slug}"


@router.post("/blueprint/draft")
def write_draft(
    req: DraftRequest, owner: str = Depends(resolve_owner)
) -> dict[str, Any]:
    settings = get_settings()
    owner_dir = drafts.owner_dir(settings.blueprint_root, owner)
    owner_dir.mkdir(parents=True, exist_ok=True)
    address = f"{req.type}.{req.name}"
    path = owner_dir / f"bp.{req.type}.{req.name}.tf"

    hcl = ""
    if req.kind == "delete":
        # Marker only — remove any stale HCL for this address.
        if path.exists():
            path.unlink()
    else:
        read_only = _read_only_attr_names(req.type)
        authored = {k: v for k, v in req.attributes.items() if k not in read_only}
        if req.component:
            tags = dict(authored.get("tags") or {})
            tags["Component"] = req.component
            authored = {**authored, "tags": tags}
        resource_hcl = _render_resource_block(req.type, req.name, authored, {})
        if req.kind == "adopt" and req.import_id:
            hcl = (
                _render_import_block(req.type, req.name, req.import_id)
                + "\n"
                + resource_hcl
            )
        else:
            hcl = resource_hcl
        tmp = path.with_suffix(".tf.tmp")
        tmp.write_text(hcl, encoding="utf-8")
        tmp.replace(path)

    entry = {
        "kind": req.kind,
        "owner": owner,
        "component": req.component,
        "source_address": req.source_address,
        "target_module": _component_target_module(req.component),
    }
    drafts.save_draft_entry(settings.blueprint_root, owner, address, entry)
    return {"address": address, "owner": owner, "entry": entry, "hcl": hcl}


@router.delete("/blueprint/draft/{type_}/{name}")
def discard_draft(
    type_: str, name: str, owner: str = Depends(resolve_owner)
) -> dict[str, Any]:
    if not _DELETE_TYPE_RE.match(type_) or not _NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="Invalid type/name")
    settings = get_settings()
    address = f"{type_}.{name}"
    path = drafts.owner_dir(settings.blueprint_root, owner) / f"bp.{type_}.{name}.tf"
    if path.exists():
        path.unlink()
    drafts.delete_draft_entry(settings.blueprint_root, owner, address)
    return {"address": address, "owner": owner, "discarded": True}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd app/backend && ./.venv/bin/python -m pytest tests/test_draft_routes.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/backend/src/devex_app/routes/blueprint.py app/backend/tests/test_draft_routes.py
git commit -m "feat(app): owner-scoped draft CRUD endpoints"
```

---

## Task 5: Inventory overlays the owner's drafts

**Files:**
- Modify: `app/backend/src/devex_app/routes/inventory.py`
- Test: `app/backend/tests/test_inventory_drafts.py`

- [ ] **Step 1: Write the failing tests**

`app/backend/tests/test_inventory_drafts.py`:

```python
from __future__ import annotations

import devex_app.routes.inventory as inv
from devex_app import drafts
from devex_app.tofu import Resource


def _managed(monkeypatch, resources):
    monkeypatch.setattr(inv, "show_state", lambda root: {"ok": True})
    monkeypatch.setattr(inv, "resources_from_state", lambda state: resources)


def test_edit_draft_annotates_managed_resource(client, blueprint_env, monkeypatch):
    _managed(
        monkeypatch,
        [
            Resource(
                address="aws_instance.solr_1",
                type="aws_instance",
                name="solr_1",
                module="",
                provider="aws",
                mode="managed",
                values={"id": "i-1", "tags": {"Component": "solr"}},
            )
        ],
    )
    drafts.save_draft_entry(
        blueprint_env,
        "alice",
        "aws_instance.solr_1",
        {"kind": "edit", "owner": "alice"},
    )
    res = client.get("/api/inventory", headers={"X-DevEx-Owner": "alice"})
    row = {r["address"]: r for r in res.json()["resources"]}["aws_instance.solr_1"]
    assert row["state"] == "managed"
    assert row["draft_kind"] == "edit"


def test_drafts_are_owner_scoped_in_inventory(client, blueprint_env, monkeypatch):
    _managed(
        monkeypatch,
        [
            Resource(
                address="aws_instance.solr_1",
                type="aws_instance",
                name="solr_1",
                module="",
                provider="aws",
                mode="managed",
                values={"id": "i-1", "tags": {}},
            )
        ],
    )
    drafts.save_draft_entry(
        blueprint_env, "alice", "aws_instance.solr_1", {"kind": "edit", "owner": "alice"}
    )
    # Bob sees no draft annotation.
    res = client.get("/api/inventory", headers={"X-DevEx-Owner": "bob"})
    row = {r["address"]: r for r in res.json()["resources"]}["aws_instance.solr_1"]
    assert row.get("draft_kind") is None
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app/backend && ./.venv/bin/python -m pytest tests/test_inventory_drafts.py -v`
Expected: FAIL — `draft_kind` missing / not owner-scoped.

- [ ] **Step 3: Make inventory owner-aware**

In `app/backend/src/devex_app/routes/inventory.py`:

Add imports at the top:

```python
from fastapi import Depends

from .. import drafts
from ._deps import resolve_owner
```

Change the route signature:

```python
@router.get("/inventory")
def inventory(owner: str = Depends(resolve_owner)) -> dict[str, Any]:
```

After `items` is fully built (right before the final `return`), overlay the
owner's draft annotations:

```python
    owner_drafts = drafts.load_drafts(settings.blueprint_root, owner)
    by_address = {it["address"]: it for it in items.values()}
    for address, entry in owner_drafts.items():
        target = by_address.get(address)
        if target is not None:
            target["draft_kind"] = entry.get("kind")
```

(Defensive: a `new`/`adopt` draft whose address isn't in `items` yet is
surfaced once the owner's draft files feed the planned source — wiring the
owner draft dir into the planned source is part of Phase 4's canvas
reconciliation; Phase 1 annotates existing live/planned items.)

Ensure every item carries `draft_kind: None` by default — in each of the
three `items[key] = {...}` blocks add `"draft_kind": None,` alongside
`"state"`.

- [ ] **Step 4: Run to verify pass**

Run: `cd app/backend && ./.venv/bin/python -m pytest tests/test_inventory_drafts.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Full backend suite + ruff**

Run: `cd app/backend && ./.venv/bin/python -m pytest && ./.venv/bin/ruff check src/devex_app/drafts.py src/devex_app/routes/_deps.py src/devex_app/routes/inventory.py tests`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add app/backend/src/devex_app/routes/inventory.py app/backend/tests/test_inventory_drafts.py
git commit -m "feat(app): inventory overlays the requesting owner's drafts"
```

---

## Task 6: Frontend draft client + types (thin)

**Files:**
- Modify: `app/frontend/lib/types.ts`
- Modify: `app/frontend/lib/api.ts`

- [ ] **Step 1: Add types**

In `app/frontend/lib/types.ts`, add `draft_kind` to `InventoryResource`:

```ts
  /** When the requesting owner has a draft for this resource, its kind. */
  draft_kind?: "new" | "adopt" | "edit" | "delete" | null;
```

Append a draft request type:

```ts
export type DraftRequest = {
  kind: "new" | "adopt" | "edit" | "delete";
  type: string;
  name: string;
  component?: string | null;
  source_address?: string | null;
  import_id?: string | null;
  attributes?: Record<string, unknown>;
};
```

- [ ] **Step 2: Add the client functions**

In `app/frontend/lib/api.ts`, append (the owner header is omitted for now —
the backend defaults it; Phase 2 wires a real owner):

```ts
/** Create/update a draft (new/adopt/edit/delete). */
export async function writeDraft(
  body: import("./types").DraftRequest,
  signal?: AbortSignal,
): Promise<{ address: string; owner: string; hcl: string }> {
  const res = await fetch("/api/blueprint/draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/blueprint/draft failed (${res.status}): ${text}`);
  }
  return res.json();
}

/** Discard a draft. */
export async function discardDraft(
  type: string,
  name: string,
  signal?: AbortSignal,
): Promise<{ discarded: boolean }> {
  const res = await fetch(
    `/api/blueprint/draft/${encodeURIComponent(type)}/${encodeURIComponent(name)}`,
    { method: "DELETE", signal },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`discard draft failed (${res.status}): ${text}`);
  }
  return res.json();
}
```

- [ ] **Step 3: Typecheck + lint**

Run: `cd app/frontend && npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/frontend/lib/types.ts app/frontend/lib/api.ts
git commit -m "feat(app): frontend draft client + draft_kind on inventory type"
```

---

## Task 7: Verify end to end

- [ ] **Step 1: Backend suite + ruff**

Run: `cd app/backend && ./.venv/bin/python -m pytest && ./.venv/bin/ruff check src tests`
Expected: tests pass; ruff clean on new files (pre-existing `Query`/import
warnings in untouched code are out of scope).

- [ ] **Step 2: Frontend tsc + lint + build**

Run: `cd app/frontend && npx tsc --noEmit && npm run lint && npm run build`
Expected: build succeeds.

- [ ] **Step 3: Boot check**

Run:
```bash
cd app/backend && ./.venv/bin/python -c "
from fastapi.testclient import TestClient
from devex_app.main import create_app
c = TestClient(create_app())
r = c.post('/api/blueprint/draft', json={'kind':'delete','type':'aws_vpc','name':'x','source_address':'aws_vpc.x'})
print('draft status:', r.status_code)
print('inventory status:', c.get('/api/inventory').status_code)
"
```
Expected: `draft status: 200`, `inventory status: 200`.

---

## Self-review notes

- **Spec coverage (Phase 1):** owner identity (T1, T3), per-owner draft store
  (T2), draft CRUD new/adopt/edit/delete (T4), inventory owner-aware draft
  overlay (T5), frontend draft client (T6). The unified `Inspector` UI,
  QuickCreate, pending-changes bar, and per-owner promote routing are
  **Phases 2–4**.
- **Owner isolation** is tested at the store (T2), route (T4), and inventory
  (T5) layers.
- **Additive:** existing `/api/blueprint/resource` + canvas untouched; draft
  namespace is new. Canvas-onto-drafts reconciliation is Phase 4.
- **Type consistency:** `DraftRequest` (T4 backend / T6 frontend) fields
  match; `draft_kind` added to `InventoryResource` (T6) is emitted by
  inventory (T5).
- **No FE unit harness** — frontend verification is tsc/lint/build.
