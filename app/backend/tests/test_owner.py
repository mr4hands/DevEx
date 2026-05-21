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
