from __future__ import annotations

from pathlib import Path

import devex_app.leaves as leaves
import devex_app.tofu as tofu

COORDS = {
    "account": "billing-prod-account",
    "region": "us-east-1",
    "layer": "infra",
    "component": "net",
}


def test_generate_config_excludes_sibling_resource_files(tmp_path, monkeypatch):
    # A leaf with boilerplate + TWO resource files. generate-config for one must
    # NOT carry the sibling resource body into the scratch dir.
    leaf = tmp_path / "leaf"
    leaf.mkdir()
    for fn, content in leaves.boilerplate_files(aws_region="us-east-1", environment="prod").items():
        (leaf / fn).write_text(content)
    (leaf / "aws_vpc.a.tf").write_text('resource "aws_vpc" "a" { cidr_block = "10.0.0.0/16" }\n')
    (leaf / "aws_s3_bucket.b.tf").write_text(
        'import { to = aws_s3_bucket.b\n id = "b" }\nresource "aws_s3_bucket" "b" {}\n'
    )

    captured = {}

    def fake_run(args, cwd, env=None):
        captured["files"] = sorted(p.name for p in Path(cwd).glob("*.tf"))
        out = Path(args[args.index("-generate-config-out") + 1])
        out.write_text('resource "aws_s3_bucket" "b" { bucket = "b" }\n')
        return ""

    monkeypatch.setattr(tofu, "_run_tofu", fake_run)

    tofu.generate_resource_config(leaf, "aws_s3_bucket", "b", "b")
    assert "aws_vpc.a.tf" not in captured["files"]
    assert "aws_s3_bucket.b.tf" not in captured["files"]
    assert "import.tf" in captured["files"]
    assert "provider.tf" in captured["files"] and "variables.tf" in captured["files"]


def _fake_run_writes_generated(args, cwd, env=None):
    out = Path(args[args.index("-generate-config-out") + 1])
    out.write_text(
        'resource "aws_s3_bucket" "logs" {\n'
        '  bucket = "acme-logs"\n'
        "  force_destroy = false\n"
        "}\n"
    )
    return ""


def _fake_run_writes_conflicting_then_errors(args, cwd, env=None):
    out = Path(args[args.index("-generate-config-out") + 1])
    out.write_text(
        "# __generated__ by OpenTofu\n"
        'resource "aws_s3_bucket" "logs" {\n'
        '  bucket              = "acme-logs"\n'
        '  bucket_prefix       = ""\n'
        "  force_destroy       = null\n"
        "  object_lock_enabled = false\n"
        "  tags                = {}\n"
        "  tags_all            = {}\n"
        "}\n"
    )
    raise tofu.TofuError("tofu plan failed (exit 1):\nbucket conflicts with bucket_prefix")


def _adopt(client, name="logs", import_id="acme-logs"):
    return client.post("/api/blueprint/draft", json={
        "kind": "adopt", "type": "aws_s3_bucket", "name": name,
        "import_id": import_id, "attributes": {"bucket": "acme-logs"}, **COORDS,
    })


def test_generate_config_replaces_thin_body(client, blueprint_env, monkeypatch):
    _adopt(client)
    monkeypatch.setattr(tofu, "_run_tofu", _fake_run_writes_generated)
    res = client.post(
        "/api/blueprint/generate-config",
        json={"type": "aws_s3_bucket", "name": "logs", **COORDS},
    )
    assert res.status_code == 200, res.text
    hcl = res.json()["hcl"]
    assert "force_destroy" in hcl
    assert "import {" in hcl
    assert 'id = "acme-logs"' in hcl


def test_generate_config_returns_cleaned_output_when_plan_errors(client, blueprint_env, monkeypatch):
    _adopt(client)
    monkeypatch.setattr(tofu, "_run_tofu", _fake_run_writes_conflicting_then_errors)
    res = client.post(
        "/api/blueprint/generate-config",
        json={"type": "aws_s3_bucket", "name": "logs", **COORDS},
    )
    assert res.status_code == 200, res.text
    hcl = res.json()["hcl"]
    assert "import {" in hcl and 'id = "acme-logs"' in hcl
    assert 'bucket              = "acme-logs"' in hcl
    assert "object_lock_enabled = false" in hcl
    assert "bucket_prefix" not in hcl
    assert "force_destroy" not in hcl
    assert "tags_all" not in hcl


def test_generate_config_404_for_missing_file(client, blueprint_env):
    res = client.post(
        "/api/blueprint/generate-config",
        json={"type": "aws_s3_bucket", "name": "nope", **COORDS},
    )
    assert res.status_code == 404


def test_generate_config_400_when_no_import_block(client, blueprint_env):
    client.post("/api/blueprint/draft", json={
        "kind": "new", "type": "aws_vpc", "name": "main",
        "attributes": {"cidr_block": "10.0.0.0/16"}, **COORDS,
    })
    res = client.post(
        "/api/blueprint/generate-config",
        json={"type": "aws_vpc", "name": "main", **COORDS},
    )
    assert res.status_code == 400
