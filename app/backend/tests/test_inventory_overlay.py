from __future__ import annotations


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
        r["address"] == "aws_vpc.main"
        and r["account"] == "billing-prod-account"
        and r["region"] == "us-east-1"
        and r["draft_kind"] == "new"
        for r in rows
    )
