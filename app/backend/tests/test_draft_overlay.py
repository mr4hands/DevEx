from __future__ import annotations


COORDS = {
    "account": "billing-prod-account",
    "region": "us-east-1",
    "layer": "infra",
    "component": "net",
}


def _leaf(blueprint_env, owner="local"):
    return blueprint_env / "drafts" / owner / "billing-prod-account/us-east-1/infra/net"


def test_new_draft_writes_resource_into_overlay_leaf(client, blueprint_env):
    res = client.post("/api/blueprint/draft", json={
        "kind": "new", "type": "aws_vpc", "name": "main",
        "attributes": {"cidr_block": "10.20.0.0/16"}, **COORDS,
    })
    assert res.status_code == 200, res.text
    leaf = _leaf(blueprint_env)
    assert (leaf / "versions.tf").exists() and (leaf / "provider.tf").exists()
    assert (leaf / "terraform.tfvars").exists()
    body = (leaf / "aws_vpc.main.tf").read_text()
    assert 'resource "aws_vpc" "main"' in body and "10.20.0.0/16" in body


def test_adopt_draft_writes_import_block(client, blueprint_env):
    res = client.post("/api/blueprint/draft", json={
        "kind": "adopt", "type": "aws_vpc", "name": "existing",
        "import_id": "vpc-123", "attributes": {}, **COORDS,
    })
    assert res.status_code == 200
    body = (_leaf(blueprint_env) / "aws_vpc.existing.tf").read_text()
    assert "import {" in body and 'id = "vpc-123"' in body


def test_discard_draft_removes_resource_file(client, blueprint_env):
    client.post("/api/blueprint/draft", json={
        "kind": "new", "type": "aws_vpc", "name": "main",
        "attributes": {"cidr_block": "10.0.0.0/16"}, **COORDS,
    })
    res = client.request("DELETE", "/api/blueprint/draft/aws_vpc/main", json=COORDS)
    assert res.status_code == 200
    assert not (_leaf(blueprint_env) / "aws_vpc.main.tf").exists()
