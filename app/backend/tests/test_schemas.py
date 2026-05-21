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


# A schema whose attributes mirror real AWS flags: `id` and `tags_all` are
# optional+computed (the legacy quirk that made them editable); `arn` is
# computed-only; `bucket` is a real optional+computed user field; tags is
# plain optional.
CANNED_COMPUTED = {
    "provider_schemas": {
        "registry.opentofu.org/hashicorp/aws": {
            "resource_schemas": {
                "aws_s3_bucket": {
                    "block": {
                        "attributes": {
                            "id": {"type": "string", "optional": True, "computed": True},
                            "tags_all": {"type": "string", "optional": True, "computed": True},
                            "arn": {"type": "string", "computed": True},
                            "bucket": {"type": "string", "optional": True, "computed": True},
                            "tags": {"type": "string", "optional": True},
                            "force_destroy": {"type": "bool", "optional": True},
                        },
                        "block_types": {},
                    }
                }
            }
        }
    }
}


def test_schemas_excludes_non_authorable_attrs(client, monkeypatch):
    monkeypatch.setattr(bp, "providers_schema", lambda root: CANNED_COMPUTED)
    res = client.get("/api/schemas?types=aws_s3_bucket")
    assert res.status_code == 200
    attrs = {a["name"]: a for a in res.json()["resources"]["aws_s3_bucket"]["attributes"]}
    # AWS-assigned identifiers are never authorable.
    assert "id" not in attrs
    assert "tags_all" not in attrs
    assert "arn" not in attrs  # computed-only
    # Real user fields survive...
    assert "bucket" in attrs and "force_destroy" in attrs and "tags" in attrs
    # ...and the computed flag is surfaced so the form can label them.
    assert attrs["bucket"]["computed"] is True
    assert attrs["force_destroy"]["computed"] is False


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
