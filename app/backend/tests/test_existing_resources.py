from __future__ import annotations

import json


def _write_manifest(bp, payload):
    (bp / "_discovered.json").write_text(json.dumps(payload), encoding="utf-8")


def test_missing_manifest_returns_empty_with_hint(client, blueprint_env):
    res = client.get("/api/existing-resources")
    assert res.status_code == 200
    body = res.json()
    assert body["groups"] == []
    assert "hint" in body


def test_serves_manifest_groups(client, blueprint_env):
    _write_manifest(
        blueprint_env,
        {
            "source": "aws",
            "generated_at": "2026-05-21T00:00:00Z",
            "scopes_loaded": ["aws_s3_bucket"],
            "groups": [
                {
                    "type": "aws_s3_bucket",
                    "resources": [
                        {
                            "address": "aws_s3_bucket.logs",
                            "type": "aws_s3_bucket",
                            "name": "logs",
                            "import_id": "acme-logs",
                            "summary_attributes": {"bucket": "acme-logs"},
                        }
                    ],
                }
            ],
        },
    )
    res = client.get("/api/existing-resources")
    body = res.json()
    assert body["source"] == "aws"
    assert body["groups"][0]["type"] == "aws_s3_bucket"
    assert body["groups"][0]["resources"][0]["import_id"] == "acme-logs"


def test_scope_filters_groups(client, blueprint_env):
    _write_manifest(
        blueprint_env,
        {
            "source": "aws",
            "generated_at": "x",
            "scopes_loaded": ["aws_s3_bucket", "aws_iam_role"],
            "groups": [
                {"type": "aws_s3_bucket", "resources": []},
                {"type": "aws_iam_role", "resources": []},
            ],
        },
    )
    res = client.get("/api/existing-resources?scope=aws_iam_role")
    types = [g["type"] for g in res.json()["groups"]]
    assert types == ["aws_iam_role"]


def test_malformed_manifest_returns_error_not_500(client, blueprint_env):
    (blueprint_env / "_discovered.json").write_text("{not json", encoding="utf-8")
    res = client.get("/api/existing-resources")
    assert res.status_code == 200
    assert "error" in res.json()
