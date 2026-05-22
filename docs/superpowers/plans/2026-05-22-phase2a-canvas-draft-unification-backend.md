# Phase 2a — Canvas/Draft Unification (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the backend author all create/edit/adopt/delete through one owner-scoped draft overlay shaped like `devex-live` (`drafts/<owner>/<account>/<region>/<layer>/<component>/`), and replace agent commit-to-PR with a deterministic `POST /api/blueprint/promote`.

**Architecture:** A new `leaves.py` owns leaf path math + per-leaf boilerplate templating + the overlay leaf dir. The draft route writes raw/adopt resource files into the overlay leaf (seeding boilerplate + `terraform.tfvars`). `generate_resource_config` is generalized to a boilerplate allowlist. A `vcs.py` seam wraps git/gh so promote is testable. `promote.py` renders the overlay into `devex-live` and opens a PR. The flat `POST /api/blueprint/resource` path is removed.

**Tech Stack:** FastAPI, pytest + `TestClient`, OpenTofu CLI (Moto for manual e2e), git/gh.

**Spec:** `docs/superpowers/specs/2026-05-22-phase2-canvas-draft-unification-design.md`

---

## File Structure

- Create: `app/backend/src/devex_app/leaves.py` — leaf path math, coord validation, boilerplate templating, overlay leaf dir + seeding.
- Create: `app/backend/src/devex_app/vcs.py` — git/gh seam (branch off main, commit, push, open PR) with an injectable runner for tests.
- Create: `app/backend/src/devex_app/routes/promote.py` — `POST /api/blueprint/promote` (render overlay → devex-live, branch+PR, clear drafts).
- Modify: `app/backend/src/devex_app/routes/blueprint.py` — `DraftRequest` gains coords; `write_draft`/`discard_draft` target the overlay leaf; remove `write_resource` (flat `POST /api/blueprint/resource`); `list_resources` reads the owner overlay.
- Modify: `app/backend/src/devex_app/tofu.py` — `generate_resource_config` uses a boilerplate allowlist (exclude sibling resource files).
- Modify: `app/backend/src/devex_app/routes/inventory.py` — read planned/draft rows from the leaf-structured overlay.
- Modify: `app/backend/src/devex_app/main.py` — register the promote router.
- Tests: `app/backend/tests/test_leaves.py`, `test_draft_overlay.py`, `test_generate_config.py` (extend), `test_vcs.py`, `test_promote.py`, `test_blueprint_flat_removed.py`, `test_inventory_overlay.py`.

**Conventions in this codebase:**
- Tests use the `client` + `blueprint_env` fixtures in `app/backend/tests/conftest.py` (`blueprint_env` = a tmp blueprint root; `X-DevEx-Owner` header sets owner, default `local`).
- Run tests from `app/backend/` with `uv run pytest`.
- Resource files in a leaf are named `<type>.<name>.tf` (no `bp.` prefix — they're real config now). Boilerplate files: `versions.tf`, `variables.tf`, `provider.tf`, `terraform.tfvars`.

---

## Task 1: Leaf path math + coord validation (`leaves.py`)

**Files:**
- Create: `app/backend/src/devex_app/leaves.py`
- Test: `app/backend/tests/test_leaves.py`

- [ ] **Step 1: Write the failing test**

```python
# app/backend/tests/test_leaves.py
from __future__ import annotations

import pytest

from devex_app import leaves


def test_leaf_relpath_joins_coords():
    assert (
        leaves.leaf_relpath("billing-prod-account", "us-east-1", "infra", "vpc")
        == "billing-prod-account/us-east-1/infra/vpc"
    )


@pytest.mark.parametrize("bad", ["", "..", "a/b", "Up", "x y", ".hidden"])
def test_leaf_coord_rejects_unsafe_segments(bad):
    with pytest.raises(ValueError):
        leaves.validate_coord(bad)


def test_leaf_coord_accepts_safe_segments():
    for ok in ["billing-prod-account", "us-east-1", "infra", "vpc", "app-x"]:
        assert leaves.validate_coord(ok) == ok
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app/backend && uv run pytest tests/test_leaves.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'devex_app.leaves'`.

- [ ] **Step 3: Write minimal implementation**

```python
# app/backend/src/devex_app/leaves.py
"""Leaf path math, coord validation, and per-leaf boilerplate for the
devex-live overlay. A leaf is account/region/layer/component."""

from __future__ import annotations

import re

# Path segments become directory names, so they must be safe path components:
# lowercase letters, digits, hyphens; no separators, dots, or spaces.
_COORD_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def validate_coord(value: str) -> str:
    if not _COORD_RE.fullmatch(value):
        raise ValueError(
            f"Invalid coord {value!r}: 1-64 chars, lowercase/digits/hyphen, "
            "no separators or dots."
        )
    return value


def leaf_relpath(account: str, region: str, layer: str, component: str) -> str:
    parts = [validate_coord(account), validate_coord(region),
             validate_coord(layer), validate_coord(component)]
    return "/".join(parts)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app/backend && uv run pytest tests/test_leaves.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/backend/src/devex_app/leaves.py app/backend/tests/test_leaves.py
git commit -m "feat(app): leaf path math + coord validation for devex-live overlay"
```

---

## Task 2: Per-leaf boilerplate templating (`leaves.py`)

**Files:**
- Modify: `app/backend/src/devex_app/leaves.py`
- Test: `app/backend/tests/test_leaves.py`

- [ ] **Step 1: Write the failing test**

```python
# append to app/backend/tests/test_leaves.py
def test_boilerplate_files_have_expected_shape():
    files = leaves.boilerplate_files(aws_region="us-east-1", environment="prod")
    assert set(files) == {"versions.tf", "variables.tf", "provider.tf", "terraform.tfvars"}
    assert 'source  = "hashicorp/aws"' in files["versions.tf"]
    assert 'variable "aws_region"' in files["variables.tf"]
    # No backend block — Spacelift manages state.
    assert "backend" not in files["provider.tf"]
    assert "default_tags" in files["provider.tf"]
    assert 'aws_region  = "us-east-1"' in files["terraform.tfvars"]
    assert 'environment = "prod"' in files["terraform.tfvars"]


def test_boilerplate_filenames_are_the_known_set():
    assert leaves.BOILERPLATE_FILENAMES == frozenset(
        {"versions.tf", "variables.tf", "provider.tf", "terraform.tfvars"}
    )
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app/backend && uv run pytest tests/test_leaves.py -k boilerplate -v`
Expected: FAIL — `AttributeError: module 'devex_app.leaves' has no attribute 'boilerplate_files'`.

- [ ] **Step 3: Write minimal implementation**

```python
# append to app/backend/src/devex_app/leaves.py

BOILERPLATE_FILENAMES = frozenset(
    {"versions.tf", "variables.tf", "provider.tf", "terraform.tfvars"}
)

_VERSIONS_TF = """\
terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
"""

_VARIABLES_TF = """\
variable "aws_region" {
  type        = string
  description = "Region this stack deploys into (per-stack input)."
}

variable "environment" {
  type        = string
  description = "Environment name for tagging (env == account)."
}

variable "common_tags" {
  type        = map(string)
  description = "Cross-cutting default_tags; Environment is merged on top."
  default = {
    Project   = "DevEx"
    ManagedBy = "OpenTofu"
  }
}

variable "use_localstack" {
  type        = bool
  description = "Point the provider at Moto. Set via TF_VAR_use_localstack; a no-op against real AWS where Spacelift injects the account role."
  default     = false
}
"""

_PROVIDER_TF = """\
# Minimal provider. No backend block — Spacelift manages state. No assume_role
# — Spacelift's per-stack AWS integration injects the account role. The
# localstack overrides are no-ops against real AWS.
provider "aws" {
  region = var.aws_region

  default_tags {
    tags = merge(var.common_tags, { Environment = var.environment })
  }

  access_key                  = var.use_localstack ? "test" : null
  secret_key                  = var.use_localstack ? "test" : null
  skip_credentials_validation = var.use_localstack
  skip_metadata_api_check     = var.use_localstack
  skip_requesting_account_id  = var.use_localstack
  s3_use_path_style           = var.use_localstack

  dynamic "endpoints" {
    for_each = var.use_localstack ? [1] : []
    content {
      ec2      = "http://localhost:4566"
      s3       = "http://localhost:4566"
      sts      = "http://localhost:4566"
      iam      = "http://localhost:4566"
      kms      = "http://localhost:4566"
      dynamodb = "http://localhost:4566"
    }
  }
}
"""


def boilerplate_files(*, aws_region: str, environment: str) -> dict[str, str]:
    tfvars = (
        "# Per-stack inputs (non-secret). Secrets go to Spacelift contexts.\n"
        f'aws_region  = "{aws_region}"\n'
        f'environment = "{environment}"\n'
    )
    return {
        "versions.tf": _VERSIONS_TF,
        "variables.tf": _VARIABLES_TF,
        "provider.tf": _PROVIDER_TF,
        "terraform.tfvars": tfvars,
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app/backend && uv run pytest tests/test_leaves.py -v`
Expected: PASS (all leaves tests).

- [ ] **Step 5: Commit**

```bash
git add app/backend/src/devex_app/leaves.py app/backend/tests/test_leaves.py
git commit -m "feat(app): per-leaf boilerplate templating"
```

---

## Task 3: Overlay leaf dir + idempotent seeding (`leaves.py`)

**Files:**
- Modify: `app/backend/src/devex_app/leaves.py`
- Test: `app/backend/tests/test_leaves.py`

- [ ] **Step 1: Write the failing test**

```python
# append to app/backend/tests/test_leaves.py
from pathlib import Path


def test_ensure_leaf_seeds_boilerplate_idempotently(tmp_path: Path):
    bp = tmp_path / "blueprint"
    bp.mkdir()
    coords = ("billing-prod-account", "us-east-1", "infra", "vpc")
    d = leaves.ensure_leaf(bp, "alice", *coords)
    assert d == bp / "drafts" / "alice" / "billing-prod-account/us-east-1/infra/vpc"
    for fn in leaves.BOILERPLATE_FILENAMES:
        assert (d / fn).exists()
    # Idempotent + non-clobbering: edit tfvars, re-ensure, edit survives.
    (d / "terraform.tfvars").write_text("aws_region = \"edited\"\n")
    leaves.ensure_leaf(bp, "alice", *coords)
    assert (d / "terraform.tfvars").read_text() == "aws_region = \"edited\"\n"


def test_ensure_leaf_rejects_owner_path_escape(tmp_path: Path):
    bp = tmp_path / "blueprint"
    bp.mkdir()
    with pytest.raises(ValueError):
        leaves.ensure_leaf(bp, "../evil", "a", "b", "c", "d")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app/backend && uv run pytest tests/test_leaves.py -k ensure_leaf -v`
Expected: FAIL — `AttributeError: ... 'ensure_leaf'`.

- [ ] **Step 3: Write minimal implementation**

```python
# append to app/backend/src/devex_app/leaves.py
from pathlib import Path

_OWNER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def owner_overlay_dir(blueprint_root: Path, owner: str) -> Path:
    if not _OWNER_RE.fullmatch(owner):
        raise ValueError(f"Invalid owner {owner!r}")
    base = blueprint_root.resolve()
    candidate = (base / "drafts" / owner).resolve()
    if base != candidate and base not in candidate.parents:
        raise ValueError(f"owner {owner!r} escapes blueprint root")
    return candidate


def leaf_dir(
    blueprint_root: Path, owner: str, account: str, region: str, layer: str, component: str
) -> Path:
    rel = leaf_relpath(account, region, layer, component)
    return owner_overlay_dir(blueprint_root, owner) / rel


def ensure_leaf(
    blueprint_root: Path, owner: str, account: str, region: str, layer: str, component: str,
    *, environment: str | None = None,
) -> Path:
    d = leaf_dir(blueprint_root, owner, account, region, layer, component)
    d.mkdir(parents=True, exist_ok=True)
    files = boilerplate_files(aws_region=region, environment=environment or _env_from_account(account))
    for fn, content in files.items():
        p = d / fn
        if not p.exists():  # never clobber edited boilerplate/tfvars
            p.write_text(content, encoding="utf-8")
    return d


def _env_from_account(account: str) -> str:
    # billing-prod-account -> prod; fall back to the account slug.
    for env in ("prod", "staging", "dev"):
        if env in account.split("-"):
            return env
    return account
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app/backend && uv run pytest tests/test_leaves.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/backend/src/devex_app/leaves.py app/backend/tests/test_leaves.py
git commit -m "feat(app): overlay leaf dir + idempotent boilerplate seeding"
```

---

## Task 4: Draft writes into the overlay leaf (`routes/blueprint.py`)

**Files:**
- Modify: `app/backend/src/devex_app/routes/blueprint.py` (`DraftRequest` ~1058-1083; `write_draft` ~1093-1136; `discard_draft` ~1139-1151)
- Test: `app/backend/tests/test_draft_overlay.py`

- [ ] **Step 1: Write the failing test**

```python
# app/backend/tests/test_draft_overlay.py
from __future__ import annotations


COORDS = {
    "account": "billing-prod-account",
    "region": "us-east-1",
    "layer": "infra",
    "component": "net",
}


def _leaf(blueprint_env, owner="local"):
    return blueprint_env / "drafts" / owner / "billing-prod-account/us-east-1/infra/net"


def test_new_draft_writes_resource_into_overlay_leaf(client, blueprint_env):
    res = client.post("/api/blueprint/draft", json={
        "kind": "new", "type": "aws_vpc", "name": "main",
        "attributes": {"cidr_block": "10.20.0.0/16"}, **COORDS,
    })
    assert res.status_code == 200, res.text
    leaf = _leaf(blueprint_env)
    assert (leaf / "versions.tf").exists() and (leaf / "provider.tf").exists()
    assert (leaf / "terraform.tfvars").exists()
    body = (leaf / "aws_vpc.main.tf").read_text()
    assert 'resource "aws_vpc" "main"' in body and "10.20.0.0/16" in body


def test_adopt_draft_writes_import_block(client, blueprint_env):
    res = client.post("/api/blueprint/draft", json={
        "kind": "adopt", "type": "aws_vpc", "name": "existing",
        "import_id": "vpc-123", "attributes": {}, **COORDS,
    })
    assert res.status_code == 200
    body = (_leaf(blueprint_env) / "aws_vpc.existing.tf").read_text()
    assert "import {" in body and 'id = "vpc-123"' in body


def test_discard_draft_removes_resource_file(client, blueprint_env):
    client.post("/api/blueprint/draft", json={
        "kind": "new", "type": "aws_vpc", "name": "main",
        "attributes": {"cidr_block": "10.0.0.0/16"}, **COORDS,
    })
    res = client.request("DELETE", "/api/blueprint/draft/aws_vpc/main", json=COORDS)
    assert res.status_code == 200
    assert not (_leaf(blueprint_env) / "aws_vpc.main.tf").exists()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app/backend && uv run pytest tests/test_draft_overlay.py -v`
Expected: FAIL — current `write_draft` writes flat `drafts/<owner>/bp.<type>.<name>.tf`, not the overlay leaf; 422 on the new coord fields or wrong path.

- [ ] **Step 3: Write minimal implementation**

Replace `DraftRequest` (add coords) and `write_draft`/`discard_draft` bodies in `app/backend/src/devex_app/routes/blueprint.py`:

```python
# DraftRequest: add the four coord fields (keep existing kind/type/name/etc.)
class DraftRequest(BaseModel):
    kind: Literal["new", "adopt", "edit", "delete"]
    type: str = Field(...)
    name: str = Field(...)
    account: str = Field(...)
    region: str = Field(...)
    layer: str = Field(...)
    component: str = Field(...)
    source_address: str | None = None
    import_id: str | None = None
    attributes: dict[str, Any] = Field(default_factory=dict)

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
```

```python
# Replace write_draft:
from .. import leaves  # add to imports at top of file

@router.post("/blueprint/draft")
def write_draft(req: DraftRequest, owner: str = Depends(resolve_owner)) -> dict[str, Any]:
    settings = get_settings()
    try:
        leaf = leaves.ensure_leaf(
            settings.blueprint_root, owner,
            req.account, req.region, req.layer, req.component,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    address = f"{req.type}.{req.name}"
    res_path = leaf / f"{req.type}.{req.name}.tf"
    hcl = ""
    if req.kind == "delete":
        if res_path.exists():
            res_path.unlink()
    else:
        read_only = _read_only_attr_names(req.type)
        authored = {k: v for k, v in req.attributes.items() if k not in read_only}
        resource_hcl = _render_resource_block(req.type, req.name, authored, {})
        if req.kind == "adopt" and req.import_id:
            hcl = _render_import_block(req.type, req.name, req.import_id) + "\n" + resource_hcl
        else:
            hcl = resource_hcl
        tmp = res_path.with_suffix(".tf.tmp")
        tmp.write_text(hcl, encoding="utf-8")
        tmp.replace(res_path)

    leaf_rel = leaves.leaf_relpath(req.account, req.region, req.layer, req.component)
    entry = {
        "kind": req.kind, "owner": owner, "leaf": leaf_rel,
        "account": req.account, "region": req.region,
        "layer": req.layer, "component": req.component,
        "source_address": req.source_address,
    }
    drafts.save_draft_entry(settings.blueprint_root, owner, f"{leaf_rel}::{address}", entry)
    return {"address": address, "owner": owner, "leaf": leaf_rel, "entry": entry, "hcl": hcl}
```

```python
# Replace discard_draft to take coords (via query or body) and target the leaf:
class DiscardDraftRequest(BaseModel):
    account: str
    region: str
    layer: str
    component: str

@router.delete("/blueprint/draft/{type_}/{name}")
def discard_draft(
    type_: str, name: str, req: DiscardDraftRequest, owner: str = Depends(resolve_owner)
) -> dict[str, Any]:
    if not _DELETE_TYPE_RE.match(type_) or not _NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="Invalid type/name")
    settings = get_settings()
    try:
        leaf = leaves.leaf_dir(settings.blueprint_root, owner,
                               req.account, req.region, req.layer, req.component)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    res_path = leaf / f"{type_}.{name}.tf"
    if res_path.exists():
        res_path.unlink()
    leaf_rel = leaves.leaf_relpath(req.account, req.region, req.layer, req.component)
    drafts.delete_draft_entry(settings.blueprint_root, owner, f"{leaf_rel}::{type_}.{name}")
    # Remove the leaf folder if no resource files remain (keep only boilerplate).
    leaves.prune_if_empty(leaf)
    return {"address": f"{type_}.{name}", "owner": owner, "discarded": True}
```

Add `prune_if_empty` to `leaves.py`:

```python
def prune_if_empty(leaf: Path) -> bool:
    """Remove the leaf dir if it holds only boilerplate (no resource files), so
    promote never creates an empty stack. Returns True if pruned."""
    if not leaf.is_dir():
        return False
    tf = {p.name for p in leaf.glob("*.tf")}
    if tf - BOILERPLATE_FILENAMES:
        return False
    for p in leaf.iterdir():
        p.unlink()
    leaf.rmdir()
    return True
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app/backend && uv run pytest tests/test_draft_overlay.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/backend/src/devex_app/routes/blueprint.py app/backend/src/devex_app/leaves.py app/backend/tests/test_draft_overlay.py
git commit -m "feat(app): draft writes target the devex-live overlay leaf"
```

---

## Task 5: Generalize generate-config sibling-exclusion (`tofu.py`)

**Files:**
- Modify: `app/backend/src/devex_app/tofu.py` (`generate_resource_config` copy loop)
- Test: `app/backend/tests/test_generate_config.py` (extend)

- [ ] **Step 1: Write the failing test**

```python
# append to app/backend/tests/test_generate_config.py
from pathlib import Path
import devex_app.leaves as leaves


def test_generate_config_excludes_sibling_resource_files(tmp_path, monkeypatch):
    # A leaf with boilerplate + TWO resource files. generate-config for one must
    # NOT carry the sibling resource body into the scratch dir.
    leaf = tmp_path / "leaf"
    leaf.mkdir()
    for fn, content in leaves.boilerplate_files(aws_region="us-east-1", environment="prod").items():
        (leaf / fn).write_text(content)
    (leaf / "aws_vpc.a.tf").write_text('resource "aws_vpc" "a" { cidr_block = "10.0.0.0/16" }\n')
    (leaf / "aws_s3_bucket.b.tf").write_text(
        'import { to = aws_s3_bucket.b\n id = "b" }\nresource "aws_s3_bucket" "b" {}\n'
    )

    captured = {}
    def fake_run(args, cwd, env=None):
        captured["files"] = sorted(p.name for p in Path(cwd).glob("*.tf"))
        out = Path(args[args.index("-generate-config-out") + 1])
        out.write_text('resource "aws_s3_bucket" "b" { bucket = "b" }\n')
        return ""
    monkeypatch.setattr(tofu, "_run_tofu", fake_run)

    tofu.generate_resource_config(leaf, "aws_s3_bucket", "b", "b")
    # scratch holds boilerplate + the lone import.tf, NOT the sibling aws_vpc.a.tf.
    assert "aws_vpc.a.tf" not in captured["files"]
    assert "aws_s3_bucket.b.tf" not in captured["files"]
    assert "import.tf" in captured["files"]
    assert "provider.tf" in captured["files"] and "variables.tf" in captured["files"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app/backend && uv run pytest tests/test_generate_config.py -k sibling -v`
Expected: FAIL — current copy loop excludes only `bp.*`, so `aws_vpc.a.tf` is copied into scratch.

- [ ] **Step 3: Write minimal implementation**

In `app/backend/src/devex_app/tofu.py`, change the copy loop inside `generate_resource_config` from the `bp.`-denylist to a boilerplate-allowlist:

```python
# at top of tofu.py imports:
from .leaves import BOILERPLATE_FILENAMES

# inside generate_resource_config, replace the existing copy loop:
        for src in sorted(blueprint_root.glob("*.tf")):
            if src.name not in BOILERPLATE_FILENAMES:
                continue  # skip sibling resource files; keep only boilerplate
            (scratch / src.name).write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
        # also copy terraform.tfvars so var defaults/values resolve
        tfvars = blueprint_root / "terraform.tfvars"
        if tfvars.exists():
            (scratch / "terraform.tfvars").write_text(tfvars.read_text(encoding="utf-8"), encoding="utf-8")
```

(Keep the rest of the function — lock copy, import.tf, TF_DATA_DIR, the try/except, `_clean_generated_config` — unchanged. `terraform.tfvars` is already in `BOILERPLATE_FILENAMES`, so the explicit copy is belt-and-suspenders; leave the loop as the single source if you prefer.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app/backend && uv run pytest tests/test_generate_config.py -v`
Expected: PASS (sibling test + the existing 5 generate-config tests).

- [ ] **Step 5: Commit**

```bash
git add app/backend/src/devex_app/tofu.py app/backend/tests/test_generate_config.py
git commit -m "fix(app): generate-config copies boilerplate allowlist, excludes sibling resources"
```

---

## Task 6: VCS seam (`vcs.py`)

**Files:**
- Create: `app/backend/src/devex_app/vcs.py`
- Test: `app/backend/tests/test_vcs.py`

- [ ] **Step 1: Write the failing test**

```python
# app/backend/tests/test_vcs.py
from __future__ import annotations

from devex_app import vcs


def test_open_pr_branches_off_main_and_targets_main():
    calls = []
    def runner(args, cwd):
        calls.append(args)
        if args[:3] == ["gh", "pr", "create"]:
            return "https://github.com/o/r/pull/1\n"
        return ""
    url = vcs.promote_branch(
        repo_root="/repo", branch="devex/alice-20260522", paths=["live/devex-live"],
        commit_message="promote", pr_title="t", pr_body="b", runner=runner,
    )
    assert url == "https://github.com/o/r/pull/1"
    # Branch is created off origin/main, never a feature branch.
    assert ["git", "fetch", "origin", "main"] in calls
    assert any(a[:3] == ["git", "checkout"] and "origin/main" in a for a in calls)
    # PR targets main.
    pr = next(a for a in calls if a[:3] == ["gh", "pr", "create"])
    assert "--base" in pr and pr[pr.index("--base") + 1] == "main"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app/backend && uv run pytest tests/test_vcs.py -v`
Expected: FAIL — no module `devex_app.vcs`.

- [ ] **Step 3: Write minimal implementation**

```python
# app/backend/src/devex_app/vcs.py
"""Thin git/gh seam for deterministic promote. `runner` is injectable so the
promote logic is unit-testable without touching a real repo."""

from __future__ import annotations

import subprocess
from collections.abc import Callable, Sequence

Runner = Callable[[Sequence[str], str], str]


def _default_runner(args: Sequence[str], cwd: str) -> str:
    return subprocess.run(
        list(args), cwd=cwd, check=True, capture_output=True, text=True
    ).stdout


def promote_branch(
    *, repo_root: str, branch: str, paths: Sequence[str],
    commit_message: str, pr_title: str, pr_body: str,
    base: str = "main", runner: Runner | None = None,
) -> str:
    """Branch off the latest origin/<base>, commit the given paths, push, open a
    PR against <base>. Returns the PR URL. Never branches off a feature branch."""
    run = runner or _default_runner
    run(["git", "fetch", "origin", base], repo_root)
    run(["git", "checkout", "-b", branch, f"origin/{base}"], repo_root)
    run(["git", "add", *paths], repo_root)
    run(["git", "commit", "-m", commit_message], repo_root)
    run(["git", "push", "-u", "origin", branch], repo_root)
    out = run(
        ["gh", "pr", "create", "--base", base, "--head", branch,
         "--title", pr_title, "--body", pr_body],
        repo_root,
    )
    return out.strip().splitlines()[-1].strip()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app/backend && uv run pytest tests/test_vcs.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/backend/src/devex_app/vcs.py app/backend/tests/test_vcs.py
git commit -m "feat(app): git/gh seam for deterministic promote"
```

---

## Task 7: Overlay→devex-live render (`leaves.py`)

**Files:**
- Modify: `app/backend/src/devex_app/leaves.py`
- Test: `app/backend/tests/test_leaves.py`

- [ ] **Step 1: Write the failing test**

```python
# append to app/backend/tests/test_leaves.py
def test_render_overlay_copies_leaves_into_target(tmp_path: Path):
    bp = tmp_path / "blueprint"; bp.mkdir()
    target = tmp_path / "devex-live"; target.mkdir()
    coords = ("billing-prod-account", "us-east-1", "infra", "vpc")
    leaf = leaves.ensure_leaf(bp, "alice", *coords)
    (leaf / "aws_vpc.main.tf").write_text('resource "aws_vpc" "main" {}\n')

    rendered = leaves.render_overlay(bp, "alice", target)
    out = target / "billing-prod-account/us-east-1/infra/vpc"
    assert rendered == [leaves.leaf_relpath(*coords)]
    assert (out / "aws_vpc.main.tf").exists()
    assert (out / "provider.tf").exists()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app/backend && uv run pytest tests/test_leaves.py -k render_overlay -v`
Expected: FAIL — `AttributeError: ... 'render_overlay'`.

- [ ] **Step 3: Write minimal implementation**

```python
# append to app/backend/src/devex_app/leaves.py
import shutil


def overlay_leaves(blueprint_root: Path, owner: str) -> list[str]:
    """Relpaths (account/region/layer/component) of leaves in the owner overlay
    that contain at least one resource file."""
    base = owner_overlay_dir(blueprint_root, owner)
    if not base.is_dir():
        return []
    found: list[str] = []
    for versions in base.rglob("versions.tf"):
        leaf = versions.parent
        if any(p.name not in BOILERPLATE_FILENAMES for p in leaf.glob("*.tf")):
            found.append(leaf.relative_to(base).as_posix())
    return sorted(found)


def render_overlay(blueprint_root: Path, owner: str, target_root: Path) -> list[str]:
    """Copy each non-empty overlay leaf into target_root/<leaf>. Returns the
    relpaths rendered."""
    base = owner_overlay_dir(blueprint_root, owner)
    rendered = overlay_leaves(blueprint_root, owner)
    for rel in rendered:
        src = base / rel
        dst = target_root / rel
        dst.mkdir(parents=True, exist_ok=True)
        for p in src.glob("*"):
            if p.is_file():
                shutil.copy2(p, dst / p.name)
    return rendered
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app/backend && uv run pytest tests/test_leaves.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/backend/src/devex_app/leaves.py app/backend/tests/test_leaves.py
git commit -m "feat(app): render owner overlay leaves into a target tree"
```

---

## Task 8: Promote route (`routes/promote.py` + `main.py`)

**Files:**
- Create: `app/backend/src/devex_app/routes/promote.py`
- Modify: `app/backend/src/devex_app/main.py` (register router)
- Test: `app/backend/tests/test_promote.py`

- [ ] **Step 1: Write the failing test**

```python
# app/backend/tests/test_promote.py
from __future__ import annotations

import devex_app.vcs as vcs
import devex_app.routes.promote as promote_mod


def test_promote_renders_overlay_and_returns_pr_url(client, blueprint_env, tmp_path, monkeypatch):
    # devex-live target under the same throwaway repo root.
    devex_live = blueprint_env.parent / "devex-live"
    monkeypatch.setenv("DEVEX_LIVE_ROOT", str(devex_live))
    promote_mod.get_settings.cache_clear()

    client.post("/api/blueprint/draft", json={
        "kind": "new", "type": "aws_vpc", "name": "main",
        "attributes": {"cidr_block": "10.0.0.0/16"},
        "account": "billing-prod-account", "region": "us-east-1",
        "layer": "infra", "component": "net",
    })

    monkeypatch.setattr(vcs, "promote_branch", lambda **kw: "https://github.com/o/r/pull/9")

    res = client.post("/api/blueprint/promote", json={})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["pr_url"] == "https://github.com/o/r/pull/9"
    assert "billing-prod-account/us-east-1/infra/net" in body["leaves"]
    assert (devex_live / "billing-prod-account/us-east-1/infra/net/aws_vpc.main.tf").exists()
    # Drafts cleared after promote.
    assert client.get("/api/blueprint/drafts").json()["drafts"] == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app/backend && uv run pytest tests/test_promote.py -v`
Expected: FAIL — no `/api/blueprint/promote` route / no `promote` module.

- [ ] **Step 3: Write minimal implementation**

Add `devex_live_root` to settings. In `app/backend/src/devex_app/settings.py`, in `Settings.__init__` add `self.devex_live_root = devex_live_root` and in `from_env`:

```python
        devex_live_root = (
            repo_root / os.environ.get("DEVEX_LIVE_ROOT", "live/devex-live")
        ).resolve()
        return cls(
            ...,  # existing kwargs
            devex_live_root=devex_live_root,
        )
```
(Add `devex_live_root: Path` to the `__init__` signature alongside the others.)

```python
# app/backend/src/devex_app/routes/promote.py
"""Deterministic promote: render the owner's overlay into devex-live, branch off
main, and open a PR. No agent."""

from __future__ import annotations

import datetime as _dt
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import drafts, leaves, vcs
from ..settings import get_settings
from ._deps import resolve_owner

router = APIRouter()


class PromoteRequest(BaseModel):
    pass  # whole-overlay promote for now


@router.post("/blueprint/promote")
def promote(req: PromoteRequest, owner: str = Depends(resolve_owner)) -> dict[str, Any]:
    settings = get_settings()
    rel_leaves = leaves.overlay_leaves(settings.blueprint_root, owner)
    if not rel_leaves:
        raise HTTPException(status_code=400, detail="No drafts to promote.")

    rendered = leaves.render_overlay(
        settings.blueprint_root, owner, settings.devex_live_root
    )
    stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%d-%H%M%S")
    branch = f"devex/{owner}-{stamp}"
    devex_rel = settings.devex_live_root.relative_to(settings.repo_root).as_posix()
    pr_url = vcs.promote_branch(
        repo_root=str(settings.repo_root),
        branch=branch,
        paths=[f"{devex_rel}/{r}" for r in rendered],
        commit_message=f"feat(devex-live): promote {owner}'s drafts ({len(rendered)} leaf/leaves)",
        pr_title=f"devex-live: {owner} promote ({len(rendered)} leaf/leaves)",
        pr_body="Promoted from the DevEx platform overlay.\n\n" + "\n".join(f"- {r}" for r in rendered),
    )

    # Clear promoted drafts + overlay leaves.
    data = drafts.load_drafts(settings.blueprint_root, owner)
    for key in [k for k, v in data.items() if v.get("leaf") in rendered]:
        drafts.delete_draft_entry(settings.blueprint_root, owner, key)
    for r in rendered:
        leaf = leaves.owner_overlay_dir(settings.blueprint_root, owner) / r
        for p in leaf.glob("*"):
            p.unlink()
        leaf.rmdir()

    return {"owner": owner, "leaves": rendered, "pr_url": pr_url, "branch": branch}
```

Register in `app/backend/src/devex_app/main.py`:

```python
    from .routes import blueprint, chat, existing, hierarchy, inventory, plan, promote
    ...
    app.include_router(promote.router, prefix="/api")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app/backend && uv run pytest tests/test_promote.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/backend/src/devex_app/routes/promote.py app/backend/src/devex_app/main.py app/backend/src/devex_app/settings.py app/backend/tests/test_promote.py
git commit -m "feat(app): deterministic POST /api/blueprint/promote"
```

---

## Task 9: Remove the flat write path; canvas reads the overlay (`routes/blueprint.py`)

**Files:**
- Modify: `app/backend/src/devex_app/routes/blueprint.py` (delete `write_resource` ~351-408; rework `list_resources` ~745-858)
- Test: `app/backend/tests/test_blueprint_flat_removed.py`

- [ ] **Step 1: Write the failing test**

```python
# app/backend/tests/test_blueprint_flat_removed.py
def test_flat_resource_write_is_gone(client, blueprint_env):
    res = client.post("/api/blueprint/resource", json={
        "type": "aws_s3_bucket", "name": "x", "attributes": {"bucket": "x"},
    })
    assert res.status_code in (404, 405)


def test_resources_reads_owner_overlay(client, blueprint_env):
    client.post("/api/blueprint/draft", json={
        "kind": "new", "type": "aws_vpc", "name": "main",
        "attributes": {"cidr_block": "10.0.0.0/16"},
        "account": "billing-prod-account", "region": "us-east-1",
        "layer": "infra", "component": "net",
    })
    out = client.get("/api/blueprint/resources").json()
    addrs = {f"{r['type']}.{r['name']}" for r in out["resources"]}
    assert "aws_vpc.main" in addrs
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app/backend && uv run pytest tests/test_blueprint_flat_removed.py -v`
Expected: FAIL — flat POST still exists (200); `list_resources` reads the flat root, not the overlay.

- [ ] **Step 3: Write minimal implementation**

Delete the `@router.post("/blueprint/resource")` `write_resource` function (and the now-unused `ResourceWriteRequest`/`BlockInstance` if nothing else references them — check with grep; keep `_render_resource_block`, `_render_import_block`, `_parse_resource_file`, `_read_only_attr_names`, which Task 4 + generate-config still use).

Rework `list_resources` to scan the owner overlay's resource files instead of `bp.*.tf` at the flat root:

```python
@router.get("/blueprint/resources")
def list_resources(owner: str = Depends(resolve_owner)) -> dict[str, Any]:
    settings = get_settings()
    base = leaves.owner_overlay_dir(settings.blueprint_root, owner)
    resources: list[dict[str, Any]] = []
    if base.is_dir():
        for tf in sorted(base.rglob("*.tf")):
            if tf.name in leaves.BOILERPLATE_FILENAMES:
                continue
            try:
                parsed = _parse_resource_file(tf)
            except Exception:  # noqa: BLE001
                continue
            if not parsed:
                continue
            leaf_rel = tf.parent.relative_to(base).as_posix()
            resources.append({
                "type": parsed["type"], "name": parsed["name"],
                "attributes": parsed["attributes"], "blocks": parsed.get("blocks") or {},
                "import_id": parsed.get("import_id"), "leaf": leaf_rel,
                "filename": tf.name,
            })
    return {"blueprint_root": str(settings.blueprint_root), "resources": resources, "edges": []}
```

(Edge derivation can return to the canvas later; Phase 2a keeps `edges: []` to stay focused. Confirm no other backend caller depends on the old flat behavior via grep before deleting.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app/backend && uv run pytest tests/test_blueprint_flat_removed.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/backend/src/devex_app/routes/blueprint.py app/backend/tests/test_blueprint_flat_removed.py
git commit -m "feat(app): remove flat write path; canvas reads owner overlay"
```

---

## Task 10: Inventory reads the leaf-structured overlay (`routes/inventory.py`)

**Files:**
- Modify: `app/backend/src/devex_app/routes/inventory.py` (the planned/draft overlay block ~106-186)
- Test: `app/backend/tests/test_inventory_overlay.py`

- [ ] **Step 1: Write the failing test**

```python
# app/backend/tests/test_inventory_overlay.py
def test_inventory_surfaces_overlay_drafts_with_coords(client, blueprint_env):
    client.post("/api/blueprint/draft", json={
        "kind": "new", "type": "aws_vpc", "name": "main",
        "attributes": {"cidr_block": "10.0.0.0/16"},
        "account": "billing-prod-account", "region": "us-east-1",
        "layer": "infra", "component": "net",
    })
    out = client.get("/api/inventory").json()
    rows = [r for r in out["resources"] if r.get("draft_kind")]
    assert any(
        r["address"] == "aws_vpc.main" and r["account"] == "billing-prod-account"
        and r["region"] == "us-east-1" and r["draft_kind"] == "new"
        for r in rows
    )
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app/backend && uv run pytest tests/test_inventory_overlay.py -v`
Expected: FAIL — inventory's draft block reads the old flat `drafts/<owner>/bp.*.tf` + `_drafts.json` per-address keys; it won't find leaf-keyed entries with coords.

- [ ] **Step 3: Write minimal implementation**

Replace the owner-drafts overlay block in `inventory.py` (the loop over `owner_drafts`) with one that reads leaf-keyed entries and derives account/region from coords:

```python
    owner_drafts = drafts.load_drafts(settings.blueprint_root, owner)
    owner_base = leaves.owner_overlay_dir(settings.blueprint_root, owner)
    by_address = {it["address"]: it for it in items.values()}
    for key, entry in owner_drafts.items():
        # key = "<account>/<region>/<layer>/<component>::<type>.<name>"
        leaf_rel, _, address = key.partition("::")
        target = by_address.get(address)
        if target is not None:
            target["draft_kind"] = entry.get("kind")
            continue
        if entry.get("kind") not in ("new", "adopt"):
            continue
        type_, _, name = address.partition(".")
        attrs: dict[str, Any] = {}
        res_path = owner_base / leaf_rel / f"{type_}.{name}.tf"
        if res_path.exists():
            try:
                parsed = _parse_resource_file(res_path)
                if parsed:
                    attrs = parsed.get("attributes") or {}
            except Exception:  # noqa: BLE001
                attrs = {}
        items[f"draft:{key}"] = {
            "address": address, "type": type_, "name": name,
            "id": None, "arn": attrs.get("arn"),
            "account": entry.get("account", "unknown"),
            "region": entry.get("region", "unknown"),
            "managed": False, "state": "planned", "draft_kind": entry.get("kind"),
            "component": entry.get("component", "Unassigned"),
            "component_source": "leaf", "tags": attrs.get("tags") or {}, "values": attrs,
        }
```

Add `from .. import leaves` to the inventory imports.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app/backend && uv run pytest tests/test_inventory_overlay.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/backend/src/devex_app/routes/inventory.py app/backend/tests/test_inventory_overlay.py
git commit -m "feat(app): inventory reads the leaf-structured overlay"
```

---

## Task 11: Full suite + manual Moto e2e

**Files:** none (verification).

- [ ] **Step 1: Run the full backend suite**

Run: `cd app/backend && uv run pytest -q`
Expected: all pass. Fix any test that referenced the removed flat path (e.g. older `test_adopt_write.py` / `test_draft_routes.py` / `test_draft_list.py` may assert the old shape — update them to the overlay model or delete if superseded; note which in the commit).

- [ ] **Step 2: Lint**

Run: `cd app/backend && uv run ruff check src/devex_app`
Expected: clean.

- [ ] **Step 3: Manual e2e against Moto**

```bash
# repo root, Moto already up (make local-up)
. ./dev.local.env
cd app/backend && uv run uvicorn devex_app.main:app --port 8090 --host 127.0.0.1 &
# author a raw resource into a leaf
curl -s localhost:8090/api/blueprint/draft -H 'content-type: application/json' -d '{
  "kind":"new","type":"aws_vpc","name":"main","attributes":{"cidr_block":"10.20.0.0/16"},
  "account":"billing-prod-account","region":"us-east-1","layer":"infra","component":"net"}'
# preview the staged leaf (against Moto)
curl -s "localhost:8090/api/plan-diff?root=blueprint" # or the per-leaf variant once added
```
Expected: the overlay leaf exists under `live/blueprint/drafts/local/billing-prod-account/us-east-1/infra/net/` with boilerplate + `aws_vpc.main.tf`; a per-leaf plan creates the VPC. (Do NOT trigger promote against the real repo in manual testing unless intended — it opens a PR.)

- [ ] **Step 4: Commit any test fixups**

```bash
git add -A app/backend/tests
git commit -m "test(app): update legacy draft/adopt tests to the overlay model"
```

---

## Self-review notes (addressed)

- **Spec coverage:** single path (Tasks 4, 9); mirror-tree staging (Tasks 2, 3, 7); raw + adopt (Task 4); per-leaf preview (existing `plan-diff?root=blueprint` reused — a per-leaf root selector is a small follow-up noted below); deterministic promote (Tasks 6, 8); flat removal (Task 9); inventory overlay (Task 10); generate-config generalization (Task 5).
- **Deferred to Phase 2b (frontend) plan:** Layer nav level, author-into-leaf UI, promote button → PR URL, deleting the agent commit prompts (`page.tsx`).
- **Known follow-up:** `plan-diff` currently takes `root=default|blueprint`; add a `leaf=<relpath>` selector so preview targets a specific overlay leaf (small; can ride Task 8 or 2b). Edge derivation in `list_resources` was dropped to `[]` for focus — restore in 2b if the canvas needs edges.
