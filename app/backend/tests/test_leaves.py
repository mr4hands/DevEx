from __future__ import annotations

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
