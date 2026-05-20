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
