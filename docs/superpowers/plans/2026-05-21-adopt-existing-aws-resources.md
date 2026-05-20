# Adopt Existing AWS Resources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drag unmanaged AWS resources from a tree onto the Blueprint canvas to adopt them (`import { }` + `resource { }`), edit them in the existing form, and promote via commit-to-PR.

**Architecture:** A discovery skill (the only LLM part) enumerates AWS via the read-only AWS MCP and writes a manifest (`live/blueprint/_discovered.json`). A deterministic `GET /api/existing-resources` serves it; the tree renders it; dragging a row POSTs an adopt-write that emits an `import` block + thin `resource` body. A `generate-config` endpoint swaps the thin body for apply-clean HCL on demand. Everything downstream of discovery is deterministic and type-agnostic.

**Tech Stack:** Backend FastAPI + pydantic + python-hcl2, tests with pytest + httpx `TestClient`. Frontend Next.js 16 + React 19 + `@xyflow/react`, verified via `tsc`/`eslint`/`build` (no unit-test runner). OpenTofu 1.12 CLI. Claude Agent SDK skill + `awslabs.aws-api-mcp-server`.

**Reference spec:** `docs/superpowers/specs/2026-05-21-adopt-existing-aws-resources-design.md`

**Conventions discovered:**
- Backend package is `devex_app` (editable install); run tests with `./.venv/bin/python -m pytest` from `app/backend`.
- Routers call `get_settings()` per-request; tests override via env (`REPO_ROOT`, `BLUEPRINT_ROOT`, `TOFU_ROOT`) + `get_settings.cache_clear()`.
- Blueprint files are flat `bp.<type>.<name>.tf` at the workspace root; sidecar `_layout.json`.
- Frontend `/api` is proxied to the backend; CORS allows GET/POST (new endpoints use GET/POST).

---

## Task 0: Backend test scaffolding

**Files:**
- Modify: `app/backend/pyproject.toml`
- Create: `app/backend/tests/__init__.py`
- Create: `app/backend/tests/conftest.py`

- [ ] **Step 1: Add pytest config to pyproject.toml**

Append after the `[tool.ruff.lint]` block:

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-q"
```

- [ ] **Step 2: Create the tests package + shared fixtures**

`app/backend/tests/__init__.py`: empty file.

`app/backend/tests/conftest.py`:

```python
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def blueprint_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Point the app at a throwaway repo root so blueprint writes land in
    tmp. Returns the blueprint workspace path."""
    monkeypatch.setenv("REPO_ROOT", str(tmp_path))
    monkeypatch.setenv("BLUEPRINT_ROOT", "blueprint")
    monkeypatch.setenv("TOFU_ROOT", "dev")
    from devex_app.settings import get_settings

    get_settings.cache_clear()
    bp = tmp_path / "blueprint"
    bp.mkdir()
    (tmp_path / "dev").mkdir()
    yield bp
    get_settings.cache_clear()


@pytest.fixture
def client(blueprint_env) -> TestClient:
    from devex_app.main import create_app

    return TestClient(create_app())
```

- [ ] **Step 3: Run the (empty) suite to confirm collection works**

Run: `cd app/backend && ./.venv/bin/python -m pytest`
Expected: `no tests ran` (exit 5) — confirms pytest + config load without error.

- [ ] **Step 4: Commit**

```bash
git add app/backend/pyproject.toml app/backend/tests/__init__.py app/backend/tests/conftest.py
git commit -m "test: backend pytest scaffolding for blueprint routes"
```

---

## Task 1: Provider schema — all types + in-process cache

**Files:**
- Modify: `app/backend/src/devex_app/tofu.py` (the `providers_schema` fn, ~line 99)
- Modify: `app/backend/src/devex_app/routes/blueprint.py` (`schemas` route, ~line 62)
- Test: `app/backend/tests/test_schemas.py`

- [ ] **Step 1: Write the failing tests**

`app/backend/tests/test_schemas.py`:

```python
from __future__ import annotations

import devex_app.routes.blueprint as bp
import devex_app.tofu as tofu


CANNED = {
    "provider_schemas": {
        "registry.opentofu.org/hashicorp/aws": {
            "resource_schemas": {
                "aws_security_group": {
                    "block": {
                        "attributes": {
                            "name": {"type": "string", "optional": True},
                            "arn": {"type": "string", "computed": True},
                        },
                        "block_types": {},
                    }
                }
            }
        }
    }
}


def test_schemas_serves_uncurated_type(client, monkeypatch):
    # aws_security_group is NOT in SUPPORTED_TYPES, but must be served.
    monkeypatch.setattr(bp, "providers_schema", lambda root: CANNED)
    res = client.get("/api/schemas?types=aws_security_group")
    assert res.status_code == 200
    body = res.json()
    assert "aws_security_group" in body["resources"]
    attrs = {a["name"] for a in body["resources"]["aws_security_group"]["attributes"]}
    assert "name" in attrs  # optional kept
    assert "arn" not in attrs  # computed-only dropped
    assert body["resources"]["aws_security_group"]["family"] == "other"


def test_schemas_rejects_malformed_type(client):
    res = client.get("/api/schemas?types=Not A Type")
    assert res.status_code == 400


def test_providers_schema_caches_by_lockfile_mtime(tmp_path, monkeypatch):
    calls = {"n": 0}

    def fake_run(args, cwd, env=None):
        calls["n"] += 1
        return '{"provider_schemas": {}}'

    monkeypatch.setattr(tofu, "_run_tofu", fake_run)
    tofu._schema_cache.clear()
    (tmp_path / ".terraform.lock.hcl").write_text("x")
    tofu.providers_schema(tmp_path)
    tofu.providers_schema(tmp_path)
    assert calls["n"] == 1  # second call served from cache
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app/backend && ./.venv/bin/python -m pytest tests/test_schemas.py -v`
Expected: FAIL — `_schema_cache` missing / `family != "other"` / malformed not rejected.

- [ ] **Step 3: Add the schema cache to tofu.py**

Replace the `providers_schema` function body (keep the docstring) with a cached version, and add `env` support + a module cache. At the top of `tofu.py` add `import os` (alongside existing imports). After the imports add:

```python
# Cache parsed provider schemas. Key: resolved workspace path. Value:
# (lockfile mtime, parsed schema). `tofu providers schema -json` returns
# ~30MB for AWS; once any resource type can be dragged, /api/schemas gets
# called often, so we parse once per provider version.
_schema_cache: dict[str, tuple[float, dict[str, Any]]] = {}
```

Update `_run_tofu` to accept an optional env:

```python
def _run_tofu(args: list[str], cwd: Path, env: dict[str, str] | None = None) -> str:
    try:
        result = subprocess.run(
            ["tofu", *args],
            cwd=cwd,
            check=True,
            capture_output=True,
            text=True,
            env=env,
        )
    except FileNotFoundError as exc:
        raise TofuError("`tofu` CLI not found on PATH") from exc
    except subprocess.CalledProcessError as exc:
        raise TofuError(
            f"tofu {' '.join(args)} failed (exit {exc.returncode}):\n{exc.stderr.strip()}"
        ) from exc
    return result.stdout
```

Replace `providers_schema`:

```python
def providers_schema(tofu_root: Path, *, use_cache: bool = True) -> dict[str, Any]:
    """`tofu providers schema -json`, cached per workspace + provider
    version. The cache key is the resolved workspace path; invalidation
    keys off the `.terraform.lock.hcl` mtime so a `tofu init` that changes
    provider versions busts it. Requires `tofu init` to have run once."""
    key = str(tofu_root.resolve())
    lock = tofu_root / ".terraform.lock.hcl"
    mtime = lock.stat().st_mtime if lock.exists() else 0.0
    if use_cache:
        hit = _schema_cache.get(key)
        if hit is not None and hit[0] == mtime:
            return hit[1]
    raw = _run_tofu(["providers", "schema", "-json"], cwd=tofu_root)
    schema = json.loads(raw) if raw.strip() else {}
    _schema_cache[key] = (mtime, schema)
    return schema
```

- [ ] **Step 4: Relax the /schemas allowlist in blueprint.py**

Add a meta helper near `SUPPORTED_TYPES` (after the dict, ~line 50):

```python
def _type_meta(type_: str) -> dict[str, str]:
    """Cosmetic label + family for a type. Curated entries win; anything
    else gets a humanized label and the generic "other" family so the
    canvas can still render it."""
    if type_ in SUPPORTED_TYPES:
        return SUPPORTED_TYPES[type_]
    leaf = type_.removeprefix("aws_").replace("_", " ")
    return {"label": leaf or type_, "family": "other"}
```

In the `schemas` route, replace the unknown-type rejection block:

```python
    settings = get_settings()
    requested = list(types) if types else list(SUPPORTED_TYPES.keys())

    # Format-only validation — any valid resource-type identifier is
    # allowed now (existing-resource adoption can surface any type).
    bad = [t for t in requested if not _DELETE_TYPE_RE.match(t)]
    if bad:
        raise HTTPException(
            status_code=400,
            detail=f"Malformed resource type identifiers: {', '.join(bad)}",
        )
```

And in the per-type loop, replace `meta = SUPPORTED_TYPES[t]` with `meta = _type_meta(t)`.

(`_DELETE_TYPE_RE` is defined later in the module at import time, which is fine — it is in scope when the route runs.)

- [ ] **Step 5: Run tests to verify pass**

Run: `cd app/backend && ./.venv/bin/python -m pytest tests/test_schemas.py -v`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add app/backend/src/devex_app/tofu.py app/backend/src/devex_app/routes/blueprint.py app/backend/tests/test_schemas.py
git commit -m "feat(app): serve provider schema for any type + cache it"
```

---

## Task 2: Adopt write — emit an import block

**Files:**
- Modify: `app/backend/src/devex_app/routes/blueprint.py` (`ResourceWriteRequest`, `write_resource`, type validator)
- Test: `app/backend/tests/test_adopt_write.py`

- [ ] **Step 1: Write the failing tests**

`app/backend/tests/test_adopt_write.py`:

```python
from __future__ import annotations


def test_adopt_write_emits_import_block(client, blueprint_env):
    res = client.post(
        "/api/blueprint/resource",
        json={
            "type": "aws_s3_bucket",
            "name": "acme_logs",
            "attributes": {"bucket": "acme-prod-logs"},
            "import_id": "acme-prod-logs",
        },
    )
    assert res.status_code == 200
    hcl = res.json()["hcl"]
    assert 'import {' in hcl
    assert "to = aws_s3_bucket.acme_logs" in hcl
    assert 'id = "acme-prod-logs"' in hcl
    assert 'resource "aws_s3_bucket" "acme_logs"' in hcl
    # File written to disk.
    assert (blueprint_env / "bp.aws_s3_bucket.acme_logs.tf").exists()


def test_adopt_write_accepts_uncurated_type(client, blueprint_env):
    res = client.post(
        "/api/blueprint/resource",
        json={
            "type": "aws_security_group",
            "name": "web",
            "attributes": {"name": "web-sg"},
            "import_id": "sg-0123",
        },
    )
    assert res.status_code == 200
    assert "to = aws_security_group.web" in res.json()["hcl"]


def test_write_without_import_id_has_no_import_block(client, blueprint_env):
    res = client.post(
        "/api/blueprint/resource",
        json={"type": "aws_vpc", "name": "main", "attributes": {"cidr_block": "10.0.0.0/16"}},
    )
    assert res.status_code == 200
    assert "import {" not in res.json()["hcl"]


def test_write_rejects_malformed_type(client, blueprint_env):
    res = client.post(
        "/api/blueprint/resource",
        json={"type": "Bad Type", "name": "x", "attributes": {}},
    )
    assert res.status_code == 422  # pydantic validation error
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app/backend && ./.venv/bin/python -m pytest tests/test_adopt_write.py -v`
Expected: FAIL — `import_id` unknown field / import block absent / uncurated type rejected.

- [ ] **Step 3: Add `import_id` to the request model + relax the type validator**

In `ResourceWriteRequest`, add the field after `name`:

```python
    import_id: str | None = Field(
        default=None,
        description="Real cloud id. When set, an `import { to, id }` block is "
        "emitted above the resource so OpenTofu adopts the existing resource "
        "instead of creating a new one.",
    )
```

Replace the `_type_supported` validator with a format-only check:

```python
    @field_validator("type")
    @classmethod
    def _type_valid(cls, v: str) -> str:
        if not _DELETE_TYPE_RE.match(v):
            raise ValueError(
                f"Invalid resource type identifier {v!r}. "
                "Must look like aws_s3_bucket."
            )
        return v
```

- [ ] **Step 4: Add the import-block renderer + wire it into `write_resource`**

Add near `_render_resource_block`:

```python
def _render_import_block(type_: str, name: str, import_id: str) -> str:
    """Render an `import { to, id }` block. `to` is a bare resource
    address; `id` is a quoted, escaped literal."""
    escaped = import_id.replace("\\", "\\\\").replace('"', '\\"')
    return f'import {{\n  to = {type_}.{name}\n  id = "{escaped}"\n}}\n'
```

In `write_resource`, replace the `hcl = _render_resource_block(...)` assignment with:

```python
    resource_hcl = _render_resource_block(
        req.type,
        req.name,
        req.attributes,
        req.blocks,
    )
    if req.import_id:
        hcl = _render_import_block(req.type, req.name, req.import_id) + "\n" + resource_hcl
    else:
        hcl = resource_hcl
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd app/backend && ./.venv/bin/python -m pytest tests/test_adopt_write.py -v`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add app/backend/src/devex_app/routes/blueprint.py app/backend/tests/test_adopt_write.py
git commit -m "feat(app): blueprint adopt-write emits import block for any type"
```

---

## Task 3: Parser — read + preserve the import block

**Files:**
- Modify: `app/backend/src/devex_app/routes/blueprint.py` (`_parse_resource_file`, `list_resources`)
- Test: `app/backend/tests/test_import_roundtrip.py`

- [ ] **Step 1: Write the failing test**

`app/backend/tests/test_import_roundtrip.py`:

```python
from __future__ import annotations


def test_import_id_round_trips_through_list(client, blueprint_env):
    # Adopt-write a resource with an import block...
    client.post(
        "/api/blueprint/resource",
        json={
            "type": "aws_s3_bucket",
            "name": "logs",
            "attributes": {"bucket": "my-logs"},
            "import_id": "my-logs",
        },
    )
    # ...then read it back: the resource carries its import_id.
    res = client.get("/api/blueprint/resources")
    assert res.status_code == 200
    resources = {r["name"]: r for r in res.json()["resources"]}
    assert resources["logs"]["import_id"] == "my-logs"


def test_resource_without_import_has_null_import_id(client, blueprint_env):
    client.post(
        "/api/blueprint/resource",
        json={"type": "aws_vpc", "name": "main", "attributes": {"cidr_block": "10.0.0.0/16"}},
    )
    res = client.get("/api/blueprint/resources")
    main = next(r for r in res.json()["resources"] if r["name"] == "main")
    assert main["import_id"] is None
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app/backend && ./.venv/bin/python -m pytest tests/test_import_roundtrip.py -v`
Expected: FAIL — `KeyError: 'import_id'`.

- [ ] **Step 3: Parse the import block in `_parse_resource_file`**

Add a helper near `_parse_resource_file`:

```python
def _import_to_matches(to: Any, type_: str, name: str) -> bool:
    """python-hcl2 returns the `to` expression either bare
    (`aws_s3_bucket.logs`) or interpolation-wrapped
    (`${aws_s3_bucket.logs}`). Normalize both before comparing."""
    if not isinstance(to, str):
        return False
    bare = to.strip()
    if bare.startswith("${") and bare.endswith("}"):
        bare = bare[2:-1].strip()
    return bare == f"{type_}.{name}"
```

In `_parse_resource_file`, after computing `attrs, blocks` and before the return, read the import block:

```python
    import_id: str | None = None
    for imp in parsed.get("import") or []:
        if _import_to_matches(imp.get("to"), type_, name):
            raw_id = imp.get("id")
            import_id = _strip_quotes(str(raw_id)) if raw_id is not None else None
            break
    return {
        "type": type_,
        "name": name,
        "attributes": attrs,
        "blocks": blocks,
        "import_id": import_id,
    }
```

(`parsed` is the `hcl2.loads(raw)` result already bound earlier in the function.)

- [ ] **Step 4: Surface `import_id` in `list_resources`**

In `list_resources`, in the success-path `resources.append({...})` call, add `"import_id": parsed.get("import_id")`. In the parse-error fallback `resources.append({...})`, add `"import_id": None`.

- [ ] **Step 5: Run tests to verify pass**

Run: `cd app/backend && ./.venv/bin/python -m pytest tests/test_import_roundtrip.py -v`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add app/backend/src/devex_app/routes/blueprint.py app/backend/tests/test_import_roundtrip.py
git commit -m "feat(app): parse + surface blueprint import_id on resource read"
```

---

## Task 4: Existing-resources endpoint (serves the manifest)

**Files:**
- Create: `app/backend/src/devex_app/routes/existing.py`
- Modify: `app/backend/src/devex_app/main.py`
- Test: `app/backend/tests/test_existing_resources.py`

- [ ] **Step 1: Write the failing tests**

`app/backend/tests/test_existing_resources.py`:

```python
from __future__ import annotations

import json


def _write_manifest(bp, payload):
    (bp / "_discovered.json").write_text(json.dumps(payload), encoding="utf-8")


def test_missing_manifest_returns_empty_with_hint(client, blueprint_env):
    res = client.get("/api/existing-resources")
    assert res.status_code == 200
    body = res.json()
    assert body["groups"] == []
    assert "hint" in body


def test_serves_manifest_groups(client, blueprint_env):
    _write_manifest(
        blueprint_env,
        {
            "source": "aws",
            "generated_at": "2026-05-21T00:00:00Z",
            "scopes_loaded": ["aws_s3_bucket"],
            "groups": [
                {
                    "type": "aws_s3_bucket",
                    "resources": [
                        {
                            "address": "aws_s3_bucket.logs",
                            "type": "aws_s3_bucket",
                            "name": "logs",
                            "import_id": "acme-logs",
                            "summary_attributes": {"bucket": "acme-logs"},
                        }
                    ],
                }
            ],
        },
    )
    res = client.get("/api/existing-resources")
    body = res.json()
    assert body["source"] == "aws"
    assert body["groups"][0]["type"] == "aws_s3_bucket"
    assert body["groups"][0]["resources"][0]["import_id"] == "acme-logs"


def test_scope_filters_groups(client, blueprint_env):
    _write_manifest(
        blueprint_env,
        {
            "source": "aws",
            "generated_at": "x",
            "scopes_loaded": ["aws_s3_bucket", "aws_iam_role"],
            "groups": [
                {"type": "aws_s3_bucket", "resources": []},
                {"type": "aws_iam_role", "resources": []},
            ],
        },
    )
    res = client.get("/api/existing-resources?scope=aws_iam_role")
    types = [g["type"] for g in res.json()["groups"]]
    assert types == ["aws_iam_role"]


def test_malformed_manifest_returns_error_not_500(client, blueprint_env):
    (blueprint_env / "_discovered.json").write_text("{not json", encoding="utf-8")
    res = client.get("/api/existing-resources")
    assert res.status_code == 200
    assert "error" in res.json()
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app/backend && ./.venv/bin/python -m pytest tests/test_existing_resources.py -v`
Expected: FAIL — 404 (route not registered).

- [ ] **Step 3: Create the route**

`app/backend/src/devex_app/routes/existing.py`:

```python
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
    settings = get_settings()
    path = settings.blueprint_root / MANIFEST_FILENAME

    empty = {"source": None, "generated_at": None, "scopes_loaded": [], "groups": []}
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
```

- [ ] **Step 4: Register the router in main.py**

Change the import line to `from .routes import blueprint, chat, existing, plan` and add after the blueprint include: `app.include_router(existing.router, prefix="/api")`.

- [ ] **Step 5: Run tests to verify pass**

Run: `cd app/backend && ./.venv/bin/python -m pytest tests/test_existing_resources.py -v`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add app/backend/src/devex_app/routes/existing.py app/backend/src/devex_app/main.py app/backend/tests/test_existing_resources.py
git commit -m "feat(app): GET /api/existing-resources serves discovery manifest"
```

---

## Task 5: Generate-config endpoint (clean HCL on demand)

**Files:**
- Modify: `app/backend/src/devex_app/tofu.py` (add `generate_resource_config`)
- Modify: `app/backend/src/devex_app/routes/blueprint.py` (add the route)
- Test: `app/backend/tests/test_generate_config.py`

- [ ] **Step 1: Write the failing tests**

`app/backend/tests/test_generate_config.py`:

```python
from __future__ import annotations

from pathlib import Path

import devex_app.tofu as tofu


def _fake_run_writes_generated(args, cwd, env=None):
    """Stand in for `tofu plan -generate-config-out=<path>` by writing a
    canned generated.tf at the requested path."""
    idx = args.index("-generate-config-out")
    out = Path(args[idx + 1])
    out.write_text(
        'resource "aws_s3_bucket" "logs" {\n  bucket = "acme-logs"\n  force_destroy = false\n}\n'
    )
    return ""


def test_generate_config_replaces_thin_body(client, blueprint_env, monkeypatch):
    # Adopt a thin resource first.
    client.post(
        "/api/blueprint/resource",
        json={
            "type": "aws_s3_bucket",
            "name": "logs",
            "attributes": {"bucket": "acme-logs"},
            "import_id": "acme-logs",
        },
    )
    monkeypatch.setattr(tofu, "_run_tofu", _fake_run_writes_generated)

    res = client.post(
        "/api/blueprint/generate-config",
        json={"type": "aws_s3_bucket", "name": "logs"},
    )
    assert res.status_code == 200
    hcl = res.json()["hcl"]
    assert "force_destroy" in hcl          # body came from generation
    assert "import {" in hcl               # import block preserved
    assert 'id = "acme-logs"' in hcl
    # Written back to disk.
    on_disk = (blueprint_env / "bp.aws_s3_bucket.logs.tf").read_text()
    assert "force_destroy" in on_disk and "import {" in on_disk


def test_generate_config_404_for_missing_file(client, blueprint_env):
    res = client.post(
        "/api/blueprint/generate-config",
        json={"type": "aws_s3_bucket", "name": "nope"},
    )
    assert res.status_code == 404


def test_generate_config_400_when_no_import_block(client, blueprint_env):
    client.post(
        "/api/blueprint/resource",
        json={"type": "aws_vpc", "name": "main", "attributes": {"cidr_block": "10.0.0.0/16"}},
    )
    res = client.post(
        "/api/blueprint/generate-config",
        json={"type": "aws_vpc", "name": "main"},
    )
    assert res.status_code == 400
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app/backend && ./.venv/bin/python -m pytest tests/test_generate_config.py -v`
Expected: FAIL — route 404 / `generate_resource_config` missing.

- [ ] **Step 3: Add `generate_resource_config` to tofu.py**

At the top of `tofu.py`, ensure `import os` is present. Add:

```python
def generate_resource_config(
    blueprint_root: Path,
    type_: str,
    name: str,
    import_id: str,
) -> str:
    """Generate apply-clean HCL for an importable resource via
    `tofu plan -generate-config-out`.

    Runs in an isolated scratch dir containing only the provider config +
    a lone `import` block. The isolation is required: generate-config-out
    SKIPS any address that already has a resource body, and the blueprint
    file has a (thin) body. We reuse the blueprint workspace's initialized
    plugins via TF_DATA_DIR so no re-`init` is needed. Returns the
    generated `resource { }` block text."""
    address = f"{type_}.{name}"
    with tempfile.TemporaryDirectory() as tmp:
        scratch = Path(tmp)
        for fname in ("versions.tf", "providers.tf", "provider.tf"):
            src = blueprint_root / fname
            if src.exists():
                (scratch / fname).write_text(
                    src.read_text(encoding="utf-8"), encoding="utf-8"
                )
        escaped = import_id.replace("\\", "\\\\").replace('"', '\\"')
        (scratch / "import.tf").write_text(
            f'import {{\n  to = {address}\n  id = "{escaped}"\n}}\n',
            encoding="utf-8",
        )
        env = os.environ.copy()
        terraform_dir = (blueprint_root / ".terraform").resolve()
        if terraform_dir.exists():
            env.setdefault("TF_DATA_DIR", str(terraform_dir))
        generated = scratch / "generated.tf"
        _run_tofu(
            [
                "plan",
                "-generate-config-out",
                str(generated),
                "-no-color",
                "-input=false",
            ],
            cwd=scratch,
            env=env,
        )
        if not generated.exists():
            raise TofuError("generate-config-out produced no output file")
        return generated.read_text(encoding="utf-8").strip()
```

- [ ] **Step 4: Add the route to blueprint.py**

Add the import of the helper at the top with the others: change `from ..tofu import TofuError, providers_schema` to `from ..tofu import TofuError, generate_resource_config, providers_schema`.

Add near the other routes:

```python
class GenerateConfigRequest(BaseModel):
    """Body of POST /api/blueprint/generate-config — the 'generate clean
    config' action for an adopted resource."""

    type: str = Field(..., description="Resource type, e.g. aws_s3_bucket")
    name: str = Field(..., description="HCL block label")


@router.post("/blueprint/generate-config")
def generate_config(req: GenerateConfigRequest) -> dict[str, Any]:
    """Replace an adopted resource's thin pre-fill body with apply-clean
    HCL from `tofu plan -generate-config-out`, preserving its import
    block. Requires the resource to already exist on disk with an import
    block (i.e. it was adopted, not authored from scratch)."""
    settings = get_settings()
    path = settings.blueprint_root / f"bp.{req.type}.{req.name}.tf"
    if not path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"No blueprint file for {req.type}.{req.name}.",
        )
    parsed = _parse_resource_file(path)
    import_id = parsed.get("import_id") if parsed else None
    if not import_id:
        raise HTTPException(
            status_code=400,
            detail="Resource has no import block; nothing to generate from.",
        )
    try:
        generated_block = generate_resource_config(
            settings.blueprint_root, req.type, req.name, import_id
        )
    except TofuError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    hcl = (
        _render_import_block(req.type, req.name, import_id)
        + "\n"
        + generated_block.strip()
        + "\n"
    )
    tmp = path.with_suffix(".tf.tmp")
    tmp.write_text(hcl, encoding="utf-8")
    tmp.replace(path)
    return {"type": req.type, "name": req.name, "hcl": hcl}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd app/backend && ./.venv/bin/python -m pytest tests/test_generate_config.py -v`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the whole backend suite + ruff**

Run: `cd app/backend && ./.venv/bin/python -m pytest && ./.venv/bin/ruff check src tests`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add app/backend/src/devex_app/tofu.py app/backend/src/devex_app/routes/blueprint.py app/backend/tests/test_generate_config.py
git commit -m "feat(app): POST /api/blueprint/generate-config for clean adopted HCL"
```

---

## Task 6: Frontend types + API client

**Files:**
- Modify: `app/frontend/lib/types.ts`
- Modify: `app/frontend/lib/api.ts`

- [ ] **Step 1: Add types**

In `app/frontend/lib/types.ts`, add `import_id` to `BlueprintResource`:

```ts
  /** Real cloud id when this resource was adopted via an import block;
   *  null/absent for resources authored from scratch. */
  import_id?: string | null;
```

Append the existing-resource types:

```ts
export type ExistingResource = {
  address: string;
  type: string;
  name: string;
  import_id: string;
  summary_attributes: Record<string, unknown>;
};

export type ExistingResourceGroup = {
  type: string;
  resources: ExistingResource[];
};

export type ExistingResourcesResponse = {
  source: string | null;
  generated_at: string | null;
  scopes_loaded: string[];
  groups: ExistingResourceGroup[];
  hint?: string;
  error?: string;
};
```

- [ ] **Step 2: Add API client functions**

In `app/frontend/lib/api.ts`, add `import_id` to the `writeBlueprintResource` body type (after `name`): `import_id?: string | null;`.

Add the imports to the top type-import block: `ExistingResourcesResponse`.

Append:

```ts
/** Reads the discovery manifest the agent skill writes. Deterministic —
 *  no LLM. `scope` filters to one resource type. */
export async function fetchExistingResources(
  signal?: AbortSignal,
  scope?: string,
): Promise<ExistingResourcesResponse> {
  const qs = scope ? `?scope=${encodeURIComponent(scope)}` : "";
  const res = await fetch(`/api/existing-resources${qs}`, {
    cache: "no-store",
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/existing-resources failed (${res.status}): ${text}`);
  }
  return res.json();
}

/** Swaps an adopted resource's thin body for apply-clean HCL via
 *  generate-config-out. Preserves the import block. */
export async function generateBlueprintConfig(
  type: string,
  name: string,
  signal?: AbortSignal,
): Promise<{ type: string; name: string; hcl: string }> {
  const res = await fetch("/api/blueprint/generate-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, name }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `/api/blueprint/generate-config failed (${res.status}): ${text}`,
    );
  }
  return res.json();
}
```

- [ ] **Step 3: Typecheck**

Run: `cd app/frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/frontend/lib/types.ts app/frontend/lib/api.ts
git commit -m "feat(app): frontend types + client for existing-resources + generate-config"
```

---

## Task 7: Family fallback for uncurated types

**Files:**
- Modify: `app/frontend/lib/resourceFamilies.ts`

- [ ] **Step 1: Inspect the current shape**

Run: `cd app/frontend && sed -n '1,200p' lib/resourceFamilies.ts`
Confirm `familyOf`, `FAMILY_CLASSES`, and any family union type.

- [ ] **Step 2: Add an `other` family + ensure `familyOf` never throws**

Add an `other` entry to `FAMILY_CLASSES` mirroring an existing entry's structure (chip + rail classes), using neutral tokens, e.g.:

```ts
  other: {
    chip: "bg-muted text-muted-foreground ring-muted-foreground/30",
    rail: "bg-muted-foreground/40",
  },
```

Ensure `familyOf(type)` returns `{ family: "other", monogram: <2-letter> }` for unknown types instead of `undefined`. If `familyOf` maps via a lookup, add a fallback: derive the monogram from the first two alphanumerics of the type leaf (`type.replace(/^aws_/, "").slice(0, 2).toUpperCase()`), family `"other"`.

(Match the exact property names the file already uses — do not invent new ones. If the family is a TS string-union, add `"other"` to it.)

- [ ] **Step 3: Typecheck**

Run: `cd app/frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/frontend/lib/resourceFamilies.ts
git commit -m "feat(app): fallback family/monogram for uncurated resource types"
```

---

## Task 8: ExistingResourceTree component

**Files:**
- Create: `app/frontend/components/ExistingResourceTree.tsx`

- [ ] **Step 1: Create the component**

`app/frontend/components/ExistingResourceTree.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState, type DragEvent } from "react";

import { fetchExistingResources } from "@/lib/api";
import { FAMILY_CLASSES, familyOf } from "@/lib/resourceFamilies";
import type {
  ExistingResource,
  ExistingResourceGroup,
} from "@/lib/types";

/** MIME used for dragging an existing (discovered) resource onto the
 *  canvas. Distinct from the palette drag type so the canvas can tell an
 *  adopt-drop from a fresh-drop. */
export const EXISTING_DRAG_TYPE = "application/devex-existing";

export function ExistingResourceTree({
  reloadKey,
  onDiscover,
}: {
  /** Bumped after a discovery tool-result so the tree refetches. */
  reloadKey?: number;
  /** Asks the parent to seed an agent discovery run for a scope
   *  ("all" or a resource type). */
  onDiscover: (scope: string) => void;
}) {
  const [groups, setGroups] = useState<ExistingResourceGroup[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const res = await fetchExistingResources(signal);
      setGroups(res.groups);
      setGeneratedAt(res.generated_at);
      setHint(res.hint ?? null);
      setError(res.error ?? null);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(ac.signal);
    return () => ac.abort();
  }, [load, reloadKey]);

  return (
    <aside className="w-[200px] shrink-0 border-r border-border bg-muted/20 flex flex-col min-h-0">
      <div className="px-3 h-8 border-b border-border flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          existing (aws)
        </span>
        <button
          type="button"
          onClick={() => onDiscover("all")}
          disabled={loading}
          title="Ask the agent to discover AWS resources"
          className="px-1.5 h-5 text-[10px] font-mono rounded-sm border border-border bg-background hover:bg-muted transition-colors disabled:opacity-50"
        >
          {loading ? "…" : "discover"}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        {error && (
          <p className="m-2 text-[10px] text-red-600 dark:text-red-400 break-words">
            {error}
          </p>
        )}
        {!error && groups.length === 0 && (
          <p className="m-2 text-[10px] text-muted-foreground leading-relaxed">
            {hint ?? "No discovered resources yet."}
          </p>
        )}
        {groups.map((g) => (
          <TreeGroup key={g.type} group={g} onDiscover={onDiscover} />
        ))}
      </div>
      {generatedAt && (
        <div className="shrink-0 border-t border-border px-2 h-6 flex items-center text-[9px] font-mono text-muted-foreground">
          discovered {new Date(generatedAt).toLocaleTimeString()}
        </div>
      )}
    </aside>
  );
}

function TreeGroup({
  group,
  onDiscover,
}: {
  group: ExistingResourceGroup;
  onDiscover: (scope: string) => void;
}) {
  const meta = familyOf(group.type);
  const classes = FAMILY_CLASSES[meta.family];
  return (
    <section>
      <header className="flex items-center gap-1.5 px-2 h-6 bg-background/80 border-b border-border">
        <span
          className={`inline-flex items-center justify-center px-1 h-[16px] min-w-[22px] rounded-sm ring-1 ring-inset font-mono text-[9px] uppercase ${classes.chip}`}
        >
          {meta.monogram}
        </span>
        <span className="font-mono text-[10px] text-foreground truncate">
          {group.type}
        </span>
        <button
          type="button"
          onClick={() => onDiscover(group.type)}
          title="Re-discover this type"
          className="ml-auto text-[9px] font-mono text-muted-foreground hover:text-foreground"
        >
          ↻
        </button>
      </header>
      <ul>
        {group.resources.map((r) => (
          <TreeRow key={r.address} resource={r} railClass={classes.rail} />
        ))}
      </ul>
    </section>
  );
}

function TreeRow({
  resource,
  railClass,
}: {
  resource: ExistingResource;
  railClass: string;
}) {
  const onDragStart = useCallback(
    (e: DragEvent<HTMLLIElement>) => {
      e.dataTransfer.setData(EXISTING_DRAG_TYPE, JSON.stringify(resource));
      e.dataTransfer.effectAllowed = "copy";
    },
    [resource],
  );
  return (
    <li
      draggable
      onDragStart={onDragStart}
      title={`Drag to adopt ${resource.address} (id: ${resource.import_id})`}
      className="relative flex items-center gap-1.5 pl-4 pr-2 h-6 cursor-grab active:cursor-grabbing hover:bg-muted transition-colors border-b border-border"
    >
      <span className={`absolute left-1.5 top-1 bottom-1 w-[2px] ${railClass}`} />
      <span className="font-mono text-[10px] text-foreground truncate">
        {resource.name}
      </span>
    </li>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd app/frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/frontend/components/ExistingResourceTree.tsx
git commit -m "feat(app): draggable existing-resources tree for the blueprint rail"
```

---

## Task 9: Canvas — host the tree, adopt on drop, import badge

**Files:**
- Modify: `app/frontend/components/BlueprintCanvas.tsx`

- [ ] **Step 1: Carry import data on nodes + reflect it from the server**

In `BlueprintNodeData`, add:

```ts
  /** Real cloud id when this node was adopted via an import block. */
  importId?: string | null;
  /** True when this node represents an adopted (imported) resource. */
  imported?: boolean;
```

In `serverNodeFrom`, add to the `data` object: `importId: r.import_id ?? null,` and `imported: Boolean(r.import_id),`.

- [ ] **Step 2: Add new props to `BlueprintCanvas` and `CanvasInner`**

Add to both prop type blocks and pass through the wrapper:

```ts
  /** Bumped to refetch the existing-resources tree. */
  existingReloadKey?: number;
  /** Seed an agent discovery run for a scope. */
  onDiscover?: (scope: string) => void;
  /** Called after an adopt-drop writes the import file, so the parent can
   *  bump the canvas reload + refetch. */
  onAdopted?: () => void;
```

- [ ] **Step 3: Import the tree + adopt helpers**

Add imports at the top:

```ts
import { writeBlueprintResource } from "@/lib/api";
import {
  ExistingResourceTree,
  EXISTING_DRAG_TYPE,
} from "@/components/ExistingResourceTree";
import type { ExistingResource } from "@/lib/types";
```

(`writeBlueprintResource` joins the existing `@/lib/api` import — merge into that line rather than duplicating.)

- [ ] **Step 4: Accept the existing MIME on drag-over + branch in `onDrop`**

`onDragOver` already calls `preventDefault`; leave it. Replace `onDrop` with a version that branches on the MIME:

```ts
  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();

      // Adopt-drop: an existing (discovered) resource dragged from the tree.
      const existingRaw = e.dataTransfer.getData(EXISTING_DRAG_TYPE);
      if (existingRaw) {
        let existing: ExistingResource;
        try {
          existing = JSON.parse(existingRaw) as ExistingResource;
        } catch {
          return;
        }
        const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        const meta = familyOf(existing.type);
        const adoptedNode: BlueprintNode = {
          id: `${existing.type}.${existing.name}`,
          type: "resource",
          position,
          data: {
            resourceType: existing.type,
            name: existing.name,
            family: meta.family,
            monogram: meta.monogram,
            attributes: existing.summary_attributes,
            importId: existing.import_id,
            imported: true,
          },
        };
        setNodes((nds) => {
          const without = nds.filter((n) => n.id !== adoptedNode.id);
          return [...without, adoptedNode];
        });
        onSelectNode(adoptedNode);
        // Persist immediately: thin pre-fill body + import block.
        void writeBlueprintResource({
          type: existing.type,
          name: existing.name,
          attributes: existing.summary_attributes,
          import_id: existing.import_id,
          position,
        })
          .then(() => onAdopted?.())
          .catch((err) => setLoadError(`Adopt failed: ${(err as Error).message}`));
        return;
      }

      // Palette-drop: a fresh resource (unchanged behavior).
      const resourceType = e.dataTransfer.getData(PALETTE_DRAG_TYPE);
      if (!resourceType) return;
      const meta = familyOf(resourceType);
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const leaf = resourceType.replace(/^aws_/, "");
      const n = (nextNameByType[resourceType] ?? 0) + 1;
      setNextNameByType((prev) => ({ ...prev, [resourceType]: n }));
      const newNode: BlueprintNode = {
        id: `${resourceType}.${leaf}_${n}_${Date.now().toString(36)}`,
        type: "resource",
        position,
        data: {
          resourceType,
          name: `${leaf}_${n}`,
          family: meta.family,
          monogram: meta.monogram,
        },
      };
      setNodes((nds) => [...nds, newNode]);
      onSelectNode(newNode);
    },
    [screenToFlowPosition, setNodes, nextNameByType, onSelectNode, onAdopted],
  );
```

- [ ] **Step 5: Render the tree in the left rail**

In `CanvasInner`'s return, the outer wrapper is `<div className="flex-1 min-h-0 flex"><Palette />...`. Add the tree before `<Palette />`:

```tsx
      <ExistingResourceTree
        reloadKey={existingReloadKey}
        onDiscover={onDiscover ?? (() => {})}
      />
```

- [ ] **Step 6: Show the import badge on adopted nodes**

In `ResourceNode`, after the `<div className="min-w-0">…</div>` block (before the source `Handle`), add:

```tsx
      {(data.imported || data.importId) && (
        <span
          title={`adopted via import (id: ${data.importId ?? "?"})`}
          className="ml-1 inline-flex items-center px-1 h-[15px] rounded-sm ring-1 ring-inset ring-sky-400/50 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 font-mono text-[8px] uppercase tracking-wide"
        >
          imp
        </span>
      )}
```

- [ ] **Step 7: Typecheck**

Run: `cd app/frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add app/frontend/components/BlueprintCanvas.tsx
git commit -m "feat(app): adopt existing resources on canvas drop with import badge"
```

---

## Task 10: Drawer — import id + generate-clean-config

**Files:**
- Modify: `app/frontend/components/BlueprintNodeDrawer.tsx`

- [ ] **Step 1: Inspect the drawer's prop + node shape**

Run: `cd app/frontend && sed -n '1,80p' components/BlueprintNodeDrawer.tsx`
Identify the `node` prop type (a `BlueprintNode`), the `onResourceWritten` callback, and where the header / form renders.

- [ ] **Step 2: Add an adopted-resource strip with a generate button**

Import the client fn at the top: `import { generateBlueprintConfig } from "@/lib/api";` and `useState` if not already imported.

Inside the drawer body, when `node.data.imported || node.data.importId` is truthy, render a strip above the form:

```tsx
{(node.data.imported || node.data.importId) && (
  <AdoptedStrip
    type={node.data.resourceType}
    name={node.data.name}
    importId={node.data.importId ?? null}
    onGenerated={onResourceWritten}
  />
)}
```

Add the component at the bottom of the file:

```tsx
function AdoptedStrip({
  type,
  name,
  importId,
  onGenerated,
}: {
  type: string;
  name: string;
  importId: string | null;
  onGenerated?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onGenerate = async () => {
    setBusy(true);
    setErr(null);
    try {
      await generateBlueprintConfig(type, name);
      onGenerated?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-3 py-2 border-b border-border bg-sky-50/60 dark:bg-sky-950/30">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="inline-flex items-center px-1 h-[15px] rounded-sm ring-1 ring-inset ring-sky-400/50 text-sky-700 dark:text-sky-300 font-mono text-[8px] uppercase">
          imported
        </span>
        <span className="font-mono text-muted-foreground truncate" title={importId ?? ""}>
          id: {importId ?? "(unknown)"}
        </span>
        <button
          type="button"
          onClick={onGenerate}
          disabled={busy}
          title="Replace the thin pre-fill with apply-clean HCL via generate-config-out"
          className="ml-auto px-1.5 h-6 text-[10px] font-mono rounded-sm border border-border bg-background hover:bg-muted transition-colors disabled:opacity-50"
        >
          {busy ? "generating…" : "generate clean config"}
        </button>
      </div>
      {err && (
        <p className="mt-1 text-[10px] text-red-600 dark:text-red-400 break-words">{err}</p>
      )}
    </div>
  );
}
```

(Adapt the JSX placement to the drawer's actual structure found in Step 1 — the strip must render only when a node is selected and inside the scrollable body, above the attribute form.)

- [ ] **Step 3: Typecheck**

Run: `cd app/frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/frontend/components/BlueprintNodeDrawer.tsx
git commit -m "feat(app): drawer shows import id + generate-clean-config for adopted nodes"
```

---

## Task 11: Wire the tree + discovery prompt into the page

**Files:**
- Modify: `app/frontend/app/page.tsx`

- [ ] **Step 1: Add a discovery-prompt builder**

Near `BLUEPRINT_COMMIT_PROMPT`, add:

```ts
// Seeded into the chat by the Existing-resources tree's "discover"
// button. The agent has the AWS MCP (read-only) + the
// aws-resource-discovery skill, so it can enumerate the scope and write
// the manifest the tree reads.
function discoveryPrompt(scope: string): string {
  const target =
    scope === "all" ? "all supported AWS resource types" : `the type \`${scope}\``;
  return `Discover existing AWS resources for the Blueprint tree.

Use the aws-resource-discovery skill to enumerate ${target} via the
read-only AWS API MCP, then write/merge the results into
\`live/blueprint/_discovered.json\` in the manifest schema the skill
documents (groups of { address, type, name, import_id, summary_attributes }).
Do not modify any other files. Report how many resources you found.`;
}
```

- [ ] **Step 2: Pass discovery + reload props to the canvas**

In the `<BlueprintCanvas ... />` JSX, add:

```tsx
            existingReloadKey={blueprintReload}
            onDiscover={(scope) => setPendingPrompt(discoveryPrompt(scope))}
            onAdopted={() => setBlueprintReload((k) => k + 1)}
```

(`blueprintReload`, `setBlueprintReload`, and `setPendingPrompt` already exist in this component.)

- [ ] **Step 3: Typecheck + lint**

Run: `cd app/frontend && npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/frontend/app/page.tsx
git commit -m "feat(app): wire discovery prompt + existing-tree reload into blueprint page"
```

---

## Task 12: aws-resource-discovery skill

**Files:**
- Create: `.claude/skills/aws-resource-discovery/SKILL.md`

- [ ] **Step 1: Write the skill**

`.claude/skills/aws-resource-discovery/SKILL.md`:

```markdown
---
name: aws-resource-discovery
description: Discover existing (unmanaged) AWS resources for the Blueprint canvas's existing-resources tree. Load when the user asks to discover/list/find existing AWS resources, populate the tree, or "what's already in AWS". Reads via the read-only AWS API MCP; writes a manifest at live/blueprint/_discovered.json. Never mutates AWS and never runs tofu apply/import.
---

# AWS resource discovery → Blueprint manifest

Enumerate existing AWS resources (read-only) and write them into the
discovery manifest the Blueprint "existing (aws)" tree renders. The tree
calls `GET /api/existing-resources`, which serves
`live/blueprint/_discovered.json`. Your job is to fill that file.

## Scope

The user (or a seeded prompt) gives a scope:
- `all` — the common supported types below.
- a single resource type (e.g. `aws_s3_bucket`) — refresh just that branch.

Default supported types: `aws_s3_bucket`, `aws_instance`, `aws_vpc`,
`aws_subnet`, `aws_iam_role`. You may discover other types when asked.

## How to discover (read-only)

Use the AWS API MCP (`awslabs.aws-api-mcp-server`, READ_OPERATIONS_ONLY).
It honors `AWS_ENDPOINT_URL_*`, so a Moto-sourced shell hits Moto and a
vanilla shell hits real AWS. Use the right list/describe call per type and
extract the correct **import id** (this is the value OpenTofu's
`import { id = ... }` expects, which is NOT always the ARN):

| Type | List call | import_id |
|------|-----------|-----------|
| aws_s3_bucket | s3 ListBuckets | bucket name |
| aws_instance | ec2 DescribeInstances | instance id (i-…) |
| aws_vpc | ec2 DescribeVpcs | vpc id (vpc-…) |
| aws_subnet | ec2 DescribeSubnets | subnet id (subnet-…) |
| aws_iam_role | iam ListRoles | role name |

For any other type, look up its import id format (the Terraform/OpenTofu
registry "Import" section via the terraform MCP) before writing entries.

## Manifest format

Write `live/blueprint/_discovered.json`. **Merge** — never drop branches
you did not just discover. Update `generated_at` and `scopes_loaded`.

\`\`\`json
{
  "source": "aws",
  "generated_at": "<current UTC ISO-8601>",
  "scopes_loaded": ["aws_s3_bucket"],
  "groups": [
    {
      "type": "aws_s3_bucket",
      "resources": [
        {
          "address": "aws_s3_bucket.<safe_name>",
          "type": "aws_s3_bucket",
          "name": "<safe_name>",
          "import_id": "<real id>",
          "summary_attributes": { "bucket": "<name>", "region": "<region>" }
        }
      ]
    }
  ]
}
\`\`\`

`name` must be a valid OpenTofu identifier (letters, digits, `_`; start
with a letter/underscore). Derive it from the resource's name/id, replacing
illegal characters with `_`. Keep `summary_attributes` small — a few
human-recognizable fields; the authoritative config comes later from
`generate-config-out`, not from this map.

## Rules

- Read-only. Never create/update/delete AWS resources. Never run
  `tofu apply` or the `tofu import` CLI (both denied).
- Only write `live/blueprint/_discovered.json`. Do not touch `bp.*.tf`.
- If the AWS MCP is unavailable, say so plainly and write nothing.
- After writing, report a one-line summary (counts per type).
```

- [ ] **Step 2: Verify the skill file parses (frontmatter present, valid JSON example)**

Run: `head -5 .claude/skills/aws-resource-discovery/SKILL.md`
Expected: YAML frontmatter with `name:` and `description:`.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/aws-resource-discovery/SKILL.md
git commit -m "feat(skill): aws-resource-discovery writes the blueprint discovery manifest"
```

---

## Task 13: Wire the read-only AWS MCP

**Files:**
- Modify: `.mcp.json`

- [ ] **Step 1: Inspect the current MCP config + the opt-in example**

Run: `cat .mcp.json && echo '---' && cat .mcp.aws.example.json`
Confirm the `awslabs.aws-api-mcp-server` entry shape and the JSON structure of `.mcp.json` (a top-level `mcpServers` object).

- [ ] **Step 2: Merge the AWS MCP entry into `.mcp.json`**

Add the `awslabs.aws-api-mcp-server` server object from `.mcp.aws.example.json` into `.mcp.json`'s `mcpServers` map verbatim (keep `READ_OPERATIONS_ONLY=true`). Preserve the existing `terraform` and `github` entries. Validate:

Run: `python3 -c "import json; json.load(open('.mcp.json')); print('valid json')"`
Expected: `valid json`.

- [ ] **Step 3: Commit**

```bash
git add .mcp.json
git commit -m "chore: enable read-only awslabs.aws-api-mcp-server for discovery"
```

---

## Task 14: Full verification + docs note

**Files:**
- Modify: `app/README.md` (or `app/frontend/COMPONENTS.md` if that's where component docs live) — short note on the adopt flow.

- [ ] **Step 1: Backend — full suite + lint**

Run: `cd app/backend && ./.venv/bin/python -m pytest && ./.venv/bin/ruff check src tests`
Expected: all tests pass, ruff clean.

- [ ] **Step 2: Frontend — typecheck, lint, build**

Run: `cd app/frontend && npx tsc --noEmit && npm run lint && npm run build`
Expected: build succeeds.

- [ ] **Step 3: Manual smoke (document outcome — needs Moto + the app running)**

Steps to perform and record in the PR description:
1. `make local-up && source dev.local.env && make bootstrap-local && make init-dev-local`
2. Seed an unmanaged bucket in Moto (e.g. `aws s3 mb s3://orphan-bucket`).
3. Start backend + frontend; open the Blueprint tab.
4. Click "discover" → confirm the agent runs the skill and the tree fills.
5. Drag the bucket onto the canvas → confirm an `import`-badged node and `live/blueprint/bp.aws_s3_bucket.*.tf` containing an import block.
6. Open the node → "generate clean config" → confirm the body is replaced and the import block survives.
7. Plan-diff tab (root=blueprint) → confirm `import` shows.

If Moto can't be run in this environment, note that explicitly rather than claiming success.

- [ ] **Step 4: Add a short docs note**

Add a paragraph to `app/README.md` under the Blueprint section describing the adopt-existing-resources flow (discover → drag → adopt → generate clean → commit-to-PR) and the read-only AWS MCP requirement.

- [ ] **Step 5: Final commit**

```bash
git add app/README.md
git commit -m "docs(app): document the adopt-existing-AWS-resources flow"
```

---

## Self-review notes

- **Spec coverage:** schema all-types+cache (T1), import block write (T2), parser round-trip (T3), existing-resources endpoint (T4), generate-config (T5), frontend types/api (T6), family fallback (T7), tree (T8), canvas adopt+badge (T9), drawer generate (T10), page wiring (T11), discovery skill (T12), MCP wiring (T13), verification+docs (T14). All design sections map to a task.
- **Deterministic vs agent:** every backend test mocks at the tofu boundary (`providers_schema` / `_run_tofu`), so the suite needs no AWS, no Moto, no provider download. The agent/Moto-dependent parts (real discovery, real generate-config-out) are covered by the manual smoke in T14.
- **Type consistency:** `import_id` (snake, backend/JSON) ↔ `importId` (camel, node data); `EXISTING_DRAG_TYPE` defined in T8, consumed in T9; `familyOf`/`FAMILY_CLASSES.other` added in T7, consumed in T8/T9.
- **Frontend testing limitation:** no unit-test runner exists; verification is `tsc` + `eslint` + `build` + the manual smoke. Not introducing a test framework (out of scope / YAGNI).
