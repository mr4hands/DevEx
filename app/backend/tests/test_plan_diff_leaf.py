from __future__ import annotations

import devex_app.routes.plan as plan_mod


def test_plan_diff_leaf_targets_the_staged_leaf(client, blueprint_env, monkeypatch):
    client.post("/api/blueprint/draft", json={
        "kind": "new", "type": "aws_vpc", "name": "main",
        "attributes": {"cidr_block": "10.0.0.0/16"},
        "account": "billing-prod-account", "region": "us-east-1",
        "layer": "infra", "component": "net",
    })
    captured = {}
    def fake_plan_diff(root):
        captured["root"] = str(root)
        return {"format_version": "1.0", "resource_changes": []}
    monkeypatch.setattr(plan_mod, "plan_diff", fake_plan_diff)
    res = client.get("/api/plan-diff", params={
        "root": "blueprint",
        "leaf": "billing-prod-account/us-east-1/infra/net"})
    assert res.status_code == 200, res.text
    assert captured["root"].endswith(
        "drafts/local/billing-prod-account/us-east-1/infra/net")


def test_plan_diff_leaf_rejects_unsafe_relpath(client, blueprint_env):
    res = client.get("/api/plan-diff", params={"root": "blueprint", "leaf": "../../etc"})
    assert res.status_code == 400


def test_plan_diff_leaf_rejects_invalid_coord_chars(client, blueprint_env):
    # Four well-formed segments, but an uppercase coord fails validate_coord
    # (regex ^[a-z0-9][a-z0-9-]{0,63}$) -> ValueError -> 400.
    res = client.get("/api/plan-diff", params={
        "root": "blueprint", "leaf": "Billing/us-east-1/infra/net"})
    assert res.status_code == 400


def test_plan_diff_leaf_missing_staged_leaf_is_404(client, blueprint_env):
    # Valid coords, but nothing staged at that leaf yet.
    res = client.get("/api/plan-diff", params={
        "root": "blueprint", "leaf": "billing-prod-account/us-east-1/infra/net"})
    assert res.status_code == 404
