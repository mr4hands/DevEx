from __future__ import annotations


def test_flat_resource_write_is_gone(client, blueprint_env):
    res = client.post("/api/blueprint/resource", json={
        "type": "aws_s3_bucket", "name": "x", "attributes": {"bucket": "x"},
    })
    assert res.status_code in (404, 405)


def test_resources_reads_owner_overlay(client, blueprint_env):
    client.post("/api/blueprint/draft", json={
        "kind": "new", "type": "aws_vpc", "name": "main",
        "attributes": {"cidr_block": "10.0.0.0/16"},
        "account": "billing-prod-account", "region": "us-east-1",
        "layer": "infra", "component": "net",
    })
    out = client.get("/api/blueprint/resources").json()
    addrs = {f"{r['type']}.{r['name']}" for r in out["resources"]}
    assert "aws_vpc.main" in addrs
