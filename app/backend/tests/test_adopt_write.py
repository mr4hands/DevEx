from __future__ import annotations

import devex_app.routes.blueprint as bp

# Schema where `arn` is computed-only (read-only) and `bucket` is a real
# editable field — used to prove the writer keeps read-only attrs out of HCL.
_CANNED = {
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


def test_adopt_write_drops_readonly_attributes(client, blueprint_env, monkeypatch):
    # Even if a client POSTs an AWS-assigned value (e.g. arn from a rich
    # discovery payload), it must never land in authored HCL.
    monkeypatch.setattr(bp, "providers_schema", lambda root: _CANNED)
    res = client.post(
        "/api/blueprint/resource",
        json={
            "type": "aws_s3_bucket",
            "name": "logs",
            "attributes": {"bucket": "acme-logs", "arn": "arn:aws:s3:::acme-logs"},
            "import_id": "acme-logs",
        },
    )
    assert res.status_code == 200
    hcl = res.json()["hcl"]
    assert "bucket" in hcl  # editable field kept
    assert "arn" not in hcl  # read-only field dropped from the body


def test_adopt_write_emits_import_block(client, blueprint_env):
    res = client.post(
        "/api/blueprint/resource",
        json={
            "type": "aws_s3_bucket",
            "name": "acme_logs",
            "attributes": {"bucket": "acme-prod-logs"},
            "import_id": "acme-prod-logs",
        },
    )
    assert res.status_code == 200
    hcl = res.json()["hcl"]
    assert "import {" in hcl
    assert "to = aws_s3_bucket.acme_logs" in hcl
    assert 'id = "acme-prod-logs"' in hcl
    assert 'resource "aws_s3_bucket" "acme_logs"' in hcl
    assert (blueprint_env / "bp.aws_s3_bucket.acme_logs.tf").exists()


def test_adopt_write_accepts_uncurated_type(client, blueprint_env):
    res = client.post(
        "/api/blueprint/resource",
        json={
            "type": "aws_security_group",
            "name": "web",
            "attributes": {"name": "web-sg"},
            "import_id": "sg-0123",
        },
    )
    assert res.status_code == 200
    assert "to = aws_security_group.web" in res.json()["hcl"]


def test_write_without_import_id_has_no_import_block(client, blueprint_env):
    res = client.post(
        "/api/blueprint/resource",
        json={
            "type": "aws_vpc",
            "name": "main",
            "attributes": {"cidr_block": "10.0.0.0/16"},
        },
    )
    assert res.status_code == 200
    assert "import {" not in res.json()["hcl"]


def test_write_rejects_malformed_type(client, blueprint_env):
    res = client.post(
        "/api/blueprint/resource",
        json={"type": "Bad Type", "name": "x", "attributes": {}},
    )
    assert res.status_code == 422  # pydantic validation error
