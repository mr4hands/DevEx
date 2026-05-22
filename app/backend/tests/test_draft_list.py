from __future__ import annotations

import devex_app.routes.blueprint as bp

_SCHEMA = {
    "provider_schemas": {
        "registry.opentofu.org/hashicorp/aws": {
            "resource_schemas": {
                "aws_s3_bucket": {"block": {"attributes": {}, "block_types": {}}}
            }
        }
    }
}

COORDS = {
    "account": "billing-prod-account",
    "region": "us-east-1",
    "layer": "infra",
    "component": "solr",
}


def test_list_drafts_returns_owner_entries(client, blueprint_env, monkeypatch):
    monkeypatch.setattr(bp, "providers_schema", lambda root: _SCHEMA)
    client.post(
        "/api/blueprint/draft",
        headers={"X-DevEx-Owner": "alice"},
        json={"kind": "new", "type": "aws_s3_bucket", "name": "logs", **COORDS},
    )
    res = client.get("/api/blueprint/drafts", headers={"X-DevEx-Owner": "alice"})
    assert res.status_code == 200
    body = res.json()
    assert body["owner"] == "alice"
    d = body["drafts"][0]
    assert d["kind"] == "new"
    assert d["component"] == "solr"
    assert d["address"].endswith("::aws_s3_bucket.logs")


def test_list_drafts_is_owner_scoped(client, blueprint_env, monkeypatch):
    monkeypatch.setattr(bp, "providers_schema", lambda root: _SCHEMA)
    client.post(
        "/api/blueprint/draft",
        headers={"X-DevEx-Owner": "alice"},
        json={"kind": "new", "type": "aws_s3_bucket", "name": "logs", **COORDS},
    )
    res = client.get("/api/blueprint/drafts", headers={"X-DevEx-Owner": "bob"})
    assert res.json()["drafts"] == []
