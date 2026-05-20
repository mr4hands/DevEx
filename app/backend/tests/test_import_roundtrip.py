from __future__ import annotations


def test_import_id_round_trips_through_list(client, blueprint_env):
    # Adopt-write a resource with an import block...
    client.post(
        "/api/blueprint/resource",
        json={
            "type": "aws_s3_bucket",
            "name": "logs",
            "attributes": {"bucket": "my-logs"},
            "import_id": "my-logs",
        },
    )
    # ...then read it back: the resource carries its import_id.
    res = client.get("/api/blueprint/resources")
    assert res.status_code == 200
    resources = {r["name"]: r for r in res.json()["resources"]}
    assert resources["logs"]["import_id"] == "my-logs"


def test_resource_without_import_has_null_import_id(client, blueprint_env):
    client.post(
        "/api/blueprint/resource",
        json={
            "type": "aws_vpc",
            "name": "main",
            "attributes": {"cidr_block": "10.0.0.0/16"},
        },
    )
    res = client.get("/api/blueprint/resources")
    main = next(r for r in res.json()["resources"] if r["name"] == "main")
    assert main["import_id"] is None
