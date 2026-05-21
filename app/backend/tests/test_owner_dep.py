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
