"""Thin wrappers around the `tofu` CLI.

Read-only by design: we shell out to `tofu show -json` to surface either the
current state or a saved plan file, and never invoke `apply`, `destroy`, or
any other mutating subcommand. Matches the repo's safety posture
(`.claude/settings.json` denies mutating tofu subcommands).
"""

from __future__ import annotations

import json
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class TofuError(RuntimeError):
    pass


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


def _run_tofu(args: list[str], cwd: Path) -> str:
    # Inherits os.environ — settings.get_settings() merges dev.local.env at
    # startup, so Moto endpoints are already present when present on disk.
    try:
        result = subprocess.run(
            ["tofu", *args],
            cwd=cwd,
            check=True,
            capture_output=True,
            text=True,
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
