from __future__ import annotations

from pathlib import Path

import pytest

from devex_app import leaves


def test_leaf_relpath_joins_coords():
    assert (
        leaves.leaf_relpath("billing-prod-account", "us-east-1", "infra", "vpc")
        == "billing-prod-account/us-east-1/infra/vpc"
    )


@pytest.mark.parametrize("bad", ["", "..", "a/b", "Up", "x y", ".hidden"])
def test_leaf_coord_rejects_unsafe_segments(bad):
    with pytest.raises(ValueError):
        leaves.validate_coord(bad)


def test_leaf_coord_accepts_safe_segments():
    for ok in ["billing-prod-account", "us-east-1", "infra", "vpc", "app-x"]:
        assert leaves.validate_coord(ok) == ok


def test_boilerplate_files_have_expected_shape():
    files = leaves.boilerplate_files(aws_region="us-east-1", environment="prod")
    assert set(files) == {"versions.tf", "variables.tf", "provider.tf", "terraform.tfvars"}
    assert 'source  = "hashicorp/aws"' in files["versions.tf"]
    assert 'variable "aws_region"' in files["variables.tf"]
    # No backend block — Spacelift manages state.
    assert "backend" not in files["provider.tf"]
    assert "default_tags" in files["provider.tf"]
    assert 'aws_region  = "us-east-1"' in files["terraform.tfvars"]
    assert 'environment = "prod"' in files["terraform.tfvars"]


def test_boilerplate_filenames_are_the_known_set():
    assert leaves.BOILERPLATE_FILENAMES == frozenset(
        {"versions.tf", "variables.tf", "provider.tf", "terraform.tfvars"}
    )


def test_ensure_leaf_seeds_boilerplate_idempotently(tmp_path: Path):
    bp = tmp_path / "blueprint"
    bp.mkdir()
    coords = ("billing-prod-account", "us-east-1", "infra", "vpc")
    d = leaves.ensure_leaf(bp, "alice", *coords)
    assert d == bp / "drafts" / "alice" / "billing-prod-account/us-east-1/infra/vpc"
    for fn in leaves.BOILERPLATE_FILENAMES:
        assert (d / fn).exists()
    # Idempotent + non-clobbering: edit tfvars, re-ensure, edit survives.
    (d / "terraform.tfvars").write_text('aws_region = "edited"\n')
    leaves.ensure_leaf(bp, "alice", *coords)
    assert (d / "terraform.tfvars").read_text() == 'aws_region = "edited"\n'


def test_ensure_leaf_rejects_owner_path_escape(tmp_path: Path):
    bp = tmp_path / "blueprint"
    bp.mkdir()
    with pytest.raises(ValueError):
        leaves.ensure_leaf(bp, "../evil", "a", "b", "c", "d")


def test_render_overlay_copies_leaves_into_target(tmp_path: Path):
    bp = tmp_path / "blueprint"
    bp.mkdir()
    target = tmp_path / "devex-live"
    target.mkdir()
    coords = ("billing-prod-account", "us-east-1", "infra", "vpc")
    leaf = leaves.ensure_leaf(bp, "alice", *coords)
    (leaf / "aws_vpc.main.tf").write_text('resource "aws_vpc" "main" {}\n')

    rendered = leaves.render_overlay(bp, "alice", target)
    out = target / "billing-prod-account/us-east-1/infra/vpc"
    assert rendered == [leaves.leaf_relpath(*coords)]
    assert (out / "aws_vpc.main.tf").exists()
    assert (out / "provider.tf").exists()


def test_overlay_leaves_skips_boilerplate_only(tmp_path: Path):
    bp = tmp_path / "blueprint"
    bp.mkdir()
    # boilerplate-only leaf (no resource files) is not surfaced
    leaves.ensure_leaf(bp, "alice", "acct", "us-east-1", "infra", "empty")
    assert leaves.overlay_leaves(bp, "alice") == []
