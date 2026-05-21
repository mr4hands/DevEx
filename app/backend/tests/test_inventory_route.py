from __future__ import annotations

import json

import devex_app.routes.inventory as inv
from devex_app.tofu import Resource


def _managed(monkeypatch, resources):
    monkeypatch.setattr(inv, "show_state", lambda root: {"ok": True})
    monkeypatch.setattr(inv, "resources_from_state", lambda state: resources)


def test_inventory_merges_and_classifies(client, blueprint_env, monkeypatch):
    _managed(
        monkeypatch,
        [
            Resource(
                address="aws_instance.solr_1",
                type="aws_instance",
                name="solr_1",
                module="",
                provider="aws",
                mode="managed",
                values={
                    "id": "i-0ab",
                    "arn": "arn:aws:ec2:us-east-1:123456789012:instance/i-0ab",
                    "tags": {"Component": "solr"},
                },
            )
        ],
    )
    (blueprint_env / "_discovered.json").write_text(
        json.dumps(
            {
                "groups": [
                    {
                        "type": "aws_s3_bucket",
                        "resources": [
                            {
                                "address": "aws_s3_bucket.old",
                                "type": "aws_s3_bucket",
                                "name": "old",
                                "import_id": "old-bucket",
                                "summary_attributes": {"arn": "arn:aws:s3:::old-bucket"},
                            }
                        ],
                    }
                ]
            }
        )
    )
    res = client.get("/api/inventory")
    assert res.status_code == 200
    items = {r["address"]: r for r in res.json()["resources"]}
    assert items["aws_instance.solr_1"]["managed"] is True
    assert items["aws_instance.solr_1"]["component"] == "solr"
    assert items["aws_instance.solr_1"]["account"] == "123456789012"
    assert items["aws_instance.solr_1"]["region"] == "us-east-1"
    assert items["aws_s3_bucket.old"]["managed"] is False
    assert items["aws_s3_bucket.old"]["component"] == "Unassigned"


def test_inventory_dedups_managed_over_unmanaged(client, blueprint_env, monkeypatch):
    # Same resource id appears in state AND discovery — managed wins, once.
    _managed(
        monkeypatch,
        [
            Resource(
                address="aws_s3_bucket.logs",
                type="aws_s3_bucket",
                name="logs",
                module="",
                provider="aws",
                mode="managed",
                values={"id": "acme-logs", "arn": "arn:aws:s3:::acme-logs", "tags": {}},
            )
        ],
    )
    (blueprint_env / "_discovered.json").write_text(
        json.dumps(
            {
                "groups": [
                    {
                        "type": "aws_s3_bucket",
                        "resources": [
                            {
                                "address": "aws_s3_bucket.logs",
                                "type": "aws_s3_bucket",
                                "name": "logs",
                                "import_id": "acme-logs",
                                "summary_attributes": {},
                            }
                        ],
                    }
                ]
            }
        )
    )
    res = client.get("/api/inventory")
    rows = [r for r in res.json()["resources"] if r["id"] == "acme-logs"]
    assert len(rows) == 1 and rows[0]["managed"] is True


def test_inventory_survives_no_state(client, blueprint_env, monkeypatch):
    # tofu show failing (no workspace) must not 500 — managed list empty.
    from devex_app.tofu import TofuError

    def boom(root):
        raise TofuError("no state")

    monkeypatch.setattr(inv, "show_state", boom)
    res = client.get("/api/inventory")
    assert res.status_code == 200
    assert res.json()["resources"] == []
