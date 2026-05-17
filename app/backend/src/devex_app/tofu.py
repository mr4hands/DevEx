"""Thin wrappers around the `tofu` CLI.

Read-only by design: we shell out to `tofu show -json` to surface either the
current state or a saved plan file, and never invoke `apply`, `destroy`, or
any other mutating subcommand. Matches the repo's safety posture
(`.claude/settings.json` denies mutating tofu subcommands).
"""

from __future__ import annotations

import json
import subprocess
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
