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
