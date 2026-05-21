from __future__ import annotations

import os
import re
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

_EXPORT_RE = re.compile(r"^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")


def _merge_dev_local_env(repo_root: Path) -> None:
    """Merge `dev.local.env` (a shell-sourceable file) into os.environ.

    The Moto-aware HCL needs `AWS_ENDPOINT_URL_*` + dummy credentials
    set in the process env; without them, the state-encryption KMS
    provider fails. We merge once at startup so every subprocess we
    spawn — `tofu show` for /api/plan, and the `claude` CLI that the
    Agent SDK launches for chat — inherits them automatically.

    Existing env vars win, so a real-AWS shell that exports its own
    creds will not be clobbered by the Moto defaults.
    """
    path = repo_root / "dev.local.env"
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        if not line or line.lstrip().startswith("#"):
            continue
        m = _EXPORT_RE.match(line)
        if not m:
            continue
        key, value = m.group(1), m.group(2)
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


@lru_cache
def get_settings() -> Settings:
    load_dotenv()
    settings = Settings.from_env()
    _merge_dev_local_env(settings.repo_root)
    return settings


class Settings:
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
        self.anthropic_api_key = anthropic_api_key
        self.anthropic_model = anthropic_model
        self.repo_root = repo_root
        self.tofu_root = tofu_root
        # The Blueprint canvas writes and reads HCL from a dedicated
        # workspace. Defaults to `live/blueprint/` so the canvas's
        # output never collides with the deployed dev environment.
        self.blueprint_root = blueprint_root
        self.default_owner = default_owner

    @classmethod
    def from_env(cls) -> Settings:
        default_repo_root = Path(__file__).resolve().parents[3].parent
        repo_root = Path(os.environ.get("REPO_ROOT") or default_repo_root).resolve()
        tofu_root = (repo_root / os.environ.get("TOFU_ROOT", "live/dev")).resolve()
        blueprint_root = (
            repo_root / os.environ.get("BLUEPRINT_ROOT", "live/blueprint")
        ).resolve()
        return cls(
            anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY") or None,
            anthropic_model=os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
            repo_root=repo_root,
            tofu_root=tofu_root,
            blueprint_root=blueprint_root,
            default_owner=os.environ.get("DEVEX_OWNER", "local"),
        )
