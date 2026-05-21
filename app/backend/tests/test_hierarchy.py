from __future__ import annotations

import json

import devex_app.routes.inventory as inv
from devex_app.tofu import Resource


def test_get_hierarchy_empty(client, blueprint_env):
    res = client.get("/api/hierarchy")
    assert res.status_code == 200
    assert res.json() == {"components": {}, "overrides": {}}


def test_put_override_sets_and_autocreates_component(client, blueprint_env):
    res = client.put(
        "/api/hierarchy/override",
        json={"address": "aws_s3_bucket.old", "component": "solr"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["overrides"]["aws_s3_bucket.old"] == "solr"
    assert "solr" in body["components"]
    # Persisted to disk.
    on_disk = json.loads((blueprint_env / "_hierarchy.json").read_text())
    assert on_disk["overrides"]["aws_s3_bucket.old"] == "solr"


def test_put_override_unassigned_does_not_create_component(client, blueprint_env):
    res = client.put(
        "/api/hierarchy/override",
        json={"address": "aws_s3_bucket.x", "component": "Unassigned"},
    )
    assert "Unassigned" not in res.json()["components"]


def test_clear_override(client, blueprint_env):
    client.put(
        "/api/hierarchy/override",
        json={"address": "aws_vpc.main", "component": "network"},
    )
    res = client.post(
        "/api/hierarchy/override/clear", json={"address": "aws_vpc.main"}
    )
    assert res.status_code == 200
    assert "aws_vpc.main" not in res.json()["overrides"]


def test_override_reclassifies_in_inventory(client, blueprint_env, monkeypatch):
    # An untagged managed resource starts Unassigned...
    monkeypatch.setattr(inv, "show_state", lambda root: {"ok": True})
    monkeypatch.setattr(
        inv,
        "resources_from_state",
        lambda state: [
            Resource(
                address="aws_s3_bucket.old",
                type="aws_s3_bucket",
                name="old",
                module="",
                provider="aws",
                mode="managed",
                values={"id": "old", "tags": {}},
            )
        ],
    )
    before = client.get("/api/inventory").json()["resources"][0]
    assert before["component"] == "Unassigned"
    # ...assigning an override moves it.
    client.put(
        "/api/hierarchy/override",
        json={"address": "aws_s3_bucket.old", "component": "solr"},
    )
    after = client.get("/api/inventory").json()["resources"][0]
    assert after["component"] == "solr" and after["component_source"] == "override"
