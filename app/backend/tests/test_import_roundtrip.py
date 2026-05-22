from __future__ import annotations

COORDS = {
    "account": "billing-prod-account",
    "region": "us-east-1",
    "layer": "infra",
    "component": "net",
}


def test_import_id_round_trips_through_list(client, blueprint_env):
    # Adopt a resource with an import block into the overlay leaf...
    client.post("/api/blueprint/draft", json={
        "kind": "adopt", "type": "aws_s3_bucket", "name": "logs",
        "import_id": "my-logs", "attributes": {"bucket": "my-logs"}, **COORDS,
    })
    # ...then read it back: the resource carries its import_id.
    res = client.get("/api/blueprint/resources")
    assert res.status_code == 200
    resources = {r["name"]: r for r in res.json()["resources"]}
    assert resources["logs"]["import_id"] == "my-logs"


def test_resource_without_import_has_null_import_id(client, blueprint_env):
    client.post("/api/blueprint/draft", json={
        "kind": "new", "type": "aws_vpc", "name": "main",
        "attributes": {"cidr_block": "10.0.0.0/16"}, **COORDS,
    })
    res = client.get("/api/blueprint/resources")
    main = next(r for r in res.json()["resources"] if r["name"] == "main")
    assert main["import_id"] is None
