from __future__ import annotations

import devex_app.routes.blueprint as bp
from devex_app import drafts

_SCHEMA = {
    "provider_schemas": {
        "registry.opentofu.org/hashicorp/aws": {
            "resource_schemas": {
                "aws_s3_bucket": {
                    "block": {
                        "attributes": {
                            "bucket": {"type": "string", "optional": True, "computed": True},
                            "arn": {"type": "string", "computed": True},
                        },
                        "block_types": {},
                    }
                }
            }
        }
    }
}


def test_new_draft_writes_file_and_entry(client, blueprint_env, monkeypatch):
    monkeypatch.setattr(bp, "providers_schema", lambda root: _SCHEMA)
    res = client.post(
        "/api/blueprint/draft",
        headers={"X-DevEx-Owner": "alice"},
        json={
            "kind": "new",
            "type": "aws_s3_bucket",
            "name": "logs",
            "component": "solr",
            "attributes": {"bucket": "acme-logs"},
        },
    )
    assert res.status_code == 200
    hcl = res.json()["hcl"]
    assert 'Component = "solr"' in hcl
    assert "acme-logs" in hcl
    # Owner-namespaced file + entry.
    owner = blueprint_env / "drafts" / "alice"
    assert (owner / "bp.aws_s3_bucket.logs.tf").exists()
    entry = drafts.load_drafts(blueprint_env, "alice")["aws_s3_bucket.logs"]
    assert entry["kind"] == "new" and entry["owner"] == "alice"


def test_adopt_draft_has_import_block(client, blueprint_env, monkeypatch):
    monkeypatch.setattr(bp, "providers_schema", lambda root: _SCHEMA)
    res = client.post(
        "/api/blueprint/draft",
        headers={"X-DevEx-Owner": "alice"},
        json={
            "kind": "adopt",
            "type": "aws_s3_bucket",
            "name": "old",
            "import_id": "old-bucket",
            "attributes": {"bucket": "old-bucket", "arn": "arn:aws:s3:::old-bucket"},
        },
    )
    hcl = res.json()["hcl"]
    assert "import {" in hcl and 'id = "old-bucket"' in hcl
    assert "arn" not in hcl  # read-only stripped


def test_delete_draft_records_marker_only(client, blueprint_env):
    res = client.post(
        "/api/blueprint/draft",
        headers={"X-DevEx-Owner": "alice"},
        json={
            "kind": "delete",
            "type": "aws_vpc",
            "name": "main",
            "source_address": "aws_vpc.main",
        },
    )
    assert res.status_code == 200
    owner = blueprint_env / "drafts" / "alice"
    assert not (owner / "bp.aws_vpc.main.tf").exists()
    assert drafts.load_drafts(blueprint_env, "alice")["aws_vpc.main"]["kind"] == "delete"


def test_discard_draft(client, blueprint_env, monkeypatch):
    monkeypatch.setattr(bp, "providers_schema", lambda root: _SCHEMA)
    client.post(
        "/api/blueprint/draft",
        headers={"X-DevEx-Owner": "alice"},
        json={"kind": "new", "type": "aws_s3_bucket", "name": "logs", "attributes": {}},
    )
    res = client.request(
        "DELETE",
        "/api/blueprint/draft/aws_s3_bucket/logs",
        headers={"X-DevEx-Owner": "alice"},
    )
    assert res.status_code == 200
    assert drafts.load_drafts(blueprint_env, "alice") == {}
    assert not (blueprint_env / "drafts" / "alice" / "bp.aws_s3_bucket.logs.tf").exists()


def test_owners_are_isolated(client, blueprint_env, monkeypatch):
    monkeypatch.setattr(bp, "providers_schema", lambda root: _SCHEMA)
    client.post(
        "/api/blueprint/draft",
        headers={"X-DevEx-Owner": "alice"},
        json={"kind": "new", "type": "aws_s3_bucket", "name": "logs", "attributes": {}},
    )
    assert drafts.load_drafts(blueprint_env, "bob") == {}
