from __future__ import annotations

from pathlib import Path

import devex_app.tofu as tofu


def _fake_run_writes_generated(args, cwd, env=None):
    """Stand in for `tofu plan -generate-config-out=<path>` by writing a
    canned generated.tf at the requested path."""
    idx = args.index("-generate-config-out")
    out = Path(args[idx + 1])
    out.write_text(
        'resource "aws_s3_bucket" "logs" {\n'
        '  bucket = "acme-logs"\n'
        "  force_destroy = false\n"
        "}\n"
    )
    return ""


def test_generate_config_replaces_thin_body(client, blueprint_env, monkeypatch):
    # Adopt a thin resource first.
    client.post(
        "/api/blueprint/resource",
        json={
            "type": "aws_s3_bucket",
            "name": "logs",
            "attributes": {"bucket": "acme-logs"},
            "import_id": "acme-logs",
        },
    )
    monkeypatch.setattr(tofu, "_run_tofu", _fake_run_writes_generated)

    res = client.post(
        "/api/blueprint/generate-config",
        json={"type": "aws_s3_bucket", "name": "logs"},
    )
    assert res.status_code == 200
    hcl = res.json()["hcl"]
    assert "force_destroy" in hcl  # body came from generation
    assert "import {" in hcl  # import block preserved
    assert 'id = "acme-logs"' in hcl
    # Written back to disk.
    on_disk = (blueprint_env / "bp.aws_s3_bucket.logs.tf").read_text()
    assert "force_destroy" in on_disk and "import {" in on_disk


def _fake_run_writes_conflicting_then_errors(args, cwd, env=None):
    """Stand in for the real Moto behavior: `-generate-config-out` writes the
    file but tofu then exits non-zero (here: conflicting bucket/bucket_prefix),
    so `_run_tofu` raises TofuError *after* the file exists."""
    idx = args.index("-generate-config-out")
    out = Path(args[idx + 1])
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


def test_clean_generated_config_drops_null_and_empty():
    raw = (
        'resource "aws_s3_bucket" "logs" {\n'
        '  bucket              = "acme-logs"\n'
        '  bucket_prefix       = ""\n'
        "  force_destroy       = null\n"
        "  object_lock_enabled = false\n"
        "  tags                = {}\n"
        "  tags_all            = {}\n"
        "}\n"
    )
    out = tofu._clean_generated_config(raw)
    assert 'bucket              = "acme-logs"' in out
    assert "object_lock_enabled = false" in out
    assert "bucket_prefix" not in out
    assert "force_destroy" not in out
    assert "tags_all" not in out
    assert "= {}" not in out


def test_generate_config_returns_cleaned_output_when_plan_errors(
    client, blueprint_env, monkeypatch
):
    client.post(
        "/api/blueprint/resource",
        json={
            "type": "aws_s3_bucket",
            "name": "logs",
            "attributes": {"bucket": "acme-logs"},
            "import_id": "acme-logs",
        },
    )
    monkeypatch.setattr(tofu, "_run_tofu", _fake_run_writes_conflicting_then_errors)

    res = client.post(
        "/api/blueprint/generate-config",
        json={"type": "aws_s3_bucket", "name": "logs"},
    )
    assert res.status_code == 200, res.text
    hcl = res.json()["hcl"]
    assert "import {" in hcl and 'id = "acme-logs"' in hcl
    assert 'bucket              = "acme-logs"' in hcl
    assert "object_lock_enabled = false" in hcl
    # Conflicting / read-only / empty defaults stripped so the result validates.
    assert "bucket_prefix" not in hcl
    assert "force_destroy" not in hcl
    assert "tags_all" not in hcl


def test_generate_config_404_for_missing_file(client, blueprint_env):
    res = client.post(
        "/api/blueprint/generate-config",
        json={"type": "aws_s3_bucket", "name": "nope"},
    )
    assert res.status_code == 404


def test_generate_config_400_when_no_import_block(client, blueprint_env):
    client.post(
        "/api/blueprint/resource",
        json={
            "type": "aws_vpc",
            "name": "main",
            "attributes": {"cidr_block": "10.0.0.0/16"},
        },
    )
    res = client.post(
        "/api/blueprint/generate-config",
        json={"type": "aws_vpc", "name": "main"},
    )
    assert res.status_code == 400
