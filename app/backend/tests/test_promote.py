from __future__ import annotations

import devex_app.routes.promote as promote_mod
import devex_app.vcs as vcs


def test_promote_renders_overlay_and_returns_pr_url(client, blueprint_env, monkeypatch):
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


def test_promote_with_no_drafts_is_400(client, blueprint_env, monkeypatch):
    devex_live = blueprint_env.parent / "devex-live"
    monkeypatch.setenv("DEVEX_LIVE_ROOT", str(devex_live))
    promote_mod.get_settings.cache_clear()
    res = client.post("/api/blueprint/promote", json={})
    assert res.status_code == 400
