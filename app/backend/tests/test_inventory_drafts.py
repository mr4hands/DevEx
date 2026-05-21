from __future__ import annotations

import devex_app.routes.inventory as inv
from devex_app import drafts
from devex_app.tofu import Resource


def _managed(monkeypatch, resources):
    monkeypatch.setattr(inv, "show_state", lambda root: {"ok": True})
    monkeypatch.setattr(inv, "resources_from_state", lambda state: resources)


def test_edit_draft_annotates_managed_resource(client, blueprint_env, monkeypatch):
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
                values={"id": "i-1", "tags": {"Component": "solr"}},
            )
        ],
    )
    drafts.save_draft_entry(
        blueprint_env,
        "alice",
        "aws_instance.solr_1",
        {"kind": "edit", "owner": "alice"},
    )
    res = client.get("/api/inventory", headers={"X-DevEx-Owner": "alice"})
    row = {r["address"]: r for r in res.json()["resources"]}["aws_instance.solr_1"]
    assert row["state"] == "managed"
    assert row["draft_kind"] == "edit"


def test_drafts_are_owner_scoped_in_inventory(client, blueprint_env, monkeypatch):
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
                values={"id": "i-1", "tags": {}},
            )
        ],
    )
    drafts.save_draft_entry(
        blueprint_env, "alice", "aws_instance.solr_1", {"kind": "edit", "owner": "alice"}
    )
    # Bob sees no draft annotation.
    res = client.get("/api/inventory", headers={"X-DevEx-Owner": "bob"})
    row = {r["address"]: r for r in res.json()["resources"]}["aws_instance.solr_1"]
    assert row.get("draft_kind") is None
