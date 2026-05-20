from __future__ import annotations


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
