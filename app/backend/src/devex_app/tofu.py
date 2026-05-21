"""Thin wrappers around the `tofu` CLI.

Read-only by design: we shell out to `tofu show -json` to surface either the
current state or a saved plan file, and never invoke `apply`, `destroy`, or
any other mutating subcommand. Matches the repo's safety posture
(`.claude/settings.json` denies mutating tofu subcommands).
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class TofuError(RuntimeError):
    pass


# Cache parsed provider schemas. Key: resolved workspace path. Value:
# (lockfile mtime, parsed schema). `tofu providers schema -json` returns
# ~30MB for AWS; once any resource type can be dragged, /api/schemas gets
# called often, so we parse once per provider version.
_schema_cache: dict[str, tuple[float, dict[str, Any]]] = {}


@dataclass
class Resource:
    address: str          # module.network.aws_vpc.this
    type: str             # aws_vpc
    name: str             # this
    module: str           # module.network ("" for root)
    provider: str         # registry.terraform.io/hashicorp/aws
    mode: str             # managed | data
    values: dict[str, Any]  # attribute payload

    @property
    def kind_label(self) -> str:
        # Friendly group label, e.g. "aws_vpc" → "VPC", "aws_s3_bucket" → "S3 Bucket".
        return self.type


def _run_tofu(args: list[str], cwd: Path, env: dict[str, str] | None = None) -> str:
    # Inherits os.environ — settings.get_settings() merges dev.local.env at
    # startup, so Moto endpoints are already present when present on disk.
    # `env` overrides that for callers that need a tweaked environment
    # (e.g. generate-config-out reusing the workspace's TF_DATA_DIR).
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


def show_state(tofu_root: Path) -> dict[str, Any]:
    """`tofu show -json` — current state as parsed JSON."""
    raw = _run_tofu(["show", "-json"], cwd=tofu_root)
    if not raw.strip():
        return {}
    return json.loads(raw)


def _walk_state_module(mod: dict[str, Any], parent: str) -> list[Resource]:
    out: list[Resource] = []
    module_address = mod.get("address") or parent or ""
    for r in mod.get("resources", []) or []:
        out.append(
            Resource(
                address=r.get("address", ""),
                type=r.get("type", ""),
                name=r.get("name", ""),
                module=module_address,
                provider=r.get("provider_name", ""),
                mode=r.get("mode", "managed"),
                values=r.get("values", {}) or {},
            )
        )
    for child in mod.get("child_modules", []) or []:
        out.extend(_walk_state_module(child, module_address))
    return out


def resources_from_state(state: dict[str, Any]) -> list[Resource]:
    root = (state.get("values") or {}).get("root_module") or {}
    if not root:
        return []
    return _walk_state_module(root, "")


# ---------------------------------------------------------------------------
# Provider schema (Blueprint tab — `tofu providers schema -json`)
# ---------------------------------------------------------------------------


def providers_schema(tofu_root: Path, *, use_cache: bool = True) -> dict[str, Any]:
    """`tofu providers schema -json`, cached per workspace + provider
    version.

    Returns the full provider schema JSON for whatever providers are
    initialized in `tofu_root`. Requires `tofu init` to have been run in
    that workspace at least once. Schemas are large (the AWS provider
    alone is ~30MB); callers should filter to the resource types they
    care about.

    The cache key is the resolved workspace path; invalidation keys off
    the `.terraform.lock.hcl` mtime so a `tofu init` that changes provider
    versions busts it. Once any resource type can be dragged onto the
    canvas, `/api/schemas` is hit often — re-parsing 30MB each time would
    be wasteful.
    """
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
    generated `resource { }` block text.
    """
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


# ---------------------------------------------------------------------------
# Plan-diff support
# ---------------------------------------------------------------------------


@dataclass
class ResourceChange:
    """A single planned change. Mirrors the `resource_changes[]` entries in
    `tofu show -json <planfile>` output."""

    address: str
    type: str
    name: str
    module: str
    provider: str
    mode: str
    actions: list[str]            # e.g. ["create"], ["update"], ["delete", "create"]
    before: dict[str, Any] | None  # null on create
    after: dict[str, Any] | None   # null on delete
    importing_id: str | None       # set when an `import { }` block resolves to this addr

    @property
    def action_kind(self) -> str:
        """Single-token category for UI grouping/coloring.

        Maps the OpenTofu actions array to one of:
        - "create" — fresh resource
        - "update" — in-place change
        - "delete" — removal
        - "replace" — destroy + recreate (`["delete", "create"]` or
          `["create", "delete"]`)
        - "import" — pure import, no other change
        - "import_update" — import + concurrent attribute update
        - "no-op" — refresh-only state change (rare in non-refresh plans)
        - "read" — data source read (uncommon in plan diffs)
        """
        actions = self.actions
        is_import = self.importing_id is not None
        if set(actions) == {"create", "delete"} or set(actions) == {"delete", "create"}:
            return "replace"
        if actions == ["create"]:
            return "create"
        if actions == ["delete"]:
            return "delete"
        if actions == ["update"]:
            return "import_update" if is_import else "update"
        if actions == ["no-op"]:
            return "import" if is_import else "no-op"
        if actions == ["read"]:
            return "read"
        # Fall through — surface the raw join so the UI can still show something.
        return "+".join(actions)


def plan_diff(tofu_root: Path) -> dict[str, Any]:
    """Run `tofu plan -out=<tmp>` then `tofu show -json <tmp>`.

    Returns the raw plan JSON, which contains a top-level `resource_changes`
    array (per the OpenTofu JSON-output spec). Plan generation can be slow
    (5-30s real, faster against Moto); callers should set their own timeout.

    Plan is *not* an apply — no mutation, no state lock acquired beyond
    plan-time refresh. We do not pass `-lock=false` because a missing lock
    would mask real concurrent-edit problems; the cost of waiting is small.
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        planfile = Path(tmpdir) / "tofu.tfplan"
        _run_tofu(
            [
                "plan",
                "-out",
                str(planfile),
                "-no-color",
                "-input=false",
                # Default exit-code mode: 0 on success regardless of whether
                # changes are pending. We don't want -detailed-exitcode here
                # since "changes detected" (exit 2) shouldn't be a backend
                # error.
            ],
            cwd=tofu_root,
        )
        raw = _run_tofu(["show", "-json", str(planfile)], cwd=tofu_root)
    if not raw.strip():
        return {}
    return json.loads(raw)


def changes_from_plan(plan: dict[str, Any]) -> list[ResourceChange]:
    out: list[ResourceChange] = []
    for rc in plan.get("resource_changes", []) or []:
        change = rc.get("change") or {}
        importing = change.get("importing") or None
        out.append(
            ResourceChange(
                address=rc.get("address", ""),
                type=rc.get("type", ""),
                name=rc.get("name", ""),
                module=rc.get("module_address", "") or "",
                provider=rc.get("provider_name", ""),
                mode=rc.get("mode", "managed"),
                actions=list(change.get("actions") or []),
                before=change.get("before"),
                after=change.get("after"),
                importing_id=(importing or {}).get("id") if importing else None,
            )
        )
    return out
