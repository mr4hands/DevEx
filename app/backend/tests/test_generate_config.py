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
