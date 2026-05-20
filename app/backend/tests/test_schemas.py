from __future__ import annotations

import devex_app.routes.blueprint as bp
import devex_app.tofu as tofu

CANNED = {
    "provider_schemas": {
        "registry.opentofu.org/hashicorp/aws": {
            "resource_schemas": {
                "aws_security_group": {
                    "block": {
                        "attributes": {
                            "name": {"type": "string", "optional": True},
                            "arn": {"type": "string", "computed": True},
                        },
                        "block_types": {},
                    }
                }
            }
        }
    }
}


def test_schemas_serves_uncurated_type(client, monkeypatch):
    # aws_security_group is NOT in SUPPORTED_TYPES, but must be served.
    monkeypatch.setattr(bp, "providers_schema", lambda root: CANNED)
    res = client.get("/api/schemas?types=aws_security_group")
    assert res.status_code == 200
    body = res.json()
    assert "aws_security_group" in body["resources"]
    attrs = {a["name"] for a in body["resources"]["aws_security_group"]["attributes"]}
    assert "name" in attrs  # optional kept
    assert "arn" not in attrs  # computed-only dropped
    assert body["resources"]["aws_security_group"]["family"] == "other"


def test_schemas_rejects_malformed_type(client):
    res = client.get("/api/schemas?types=Not A Type")
    assert res.status_code == 400


def test_providers_schema_caches_by_lockfile_mtime(tmp_path, monkeypatch):
    calls = {"n": 0}

    def fake_run(args, cwd, env=None):
        calls["n"] += 1
        return '{"provider_schemas": {}}'

    monkeypatch.setattr(tofu, "_run_tofu", fake_run)
    tofu._schema_cache.clear()
    (tmp_path / ".terraform.lock.hcl").write_text("x")
    tofu.providers_schema(tmp_path)
    tofu.providers_schema(tmp_path)
    assert calls["n"] == 1  # second call served from cache
