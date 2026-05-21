from __future__ import annotations

import devex_app.routes.inventory as inv


def _no_managed(monkeypatch):
    monkeypatch.setattr(inv, "show_state", lambda root: {})
    monkeypatch.setattr(inv, "resources_from_state", lambda state: [])


def test_inventory_includes_sandbox_as_planned(client, blueprint_env, monkeypatch):
    _no_managed(monkeypatch)
    # A freshly-authored sandbox resource tagged with its component.
    (blueprint_env / "bp.aws_instance.solr_extra.tf").write_text(
        'resource "aws_instance" "solr_extra" {\n'
        '  instance_type = "t3.large"\n'
        "\n"
        "  tags = {\n"
        '    Component = "solr"\n'
        "  }\n"
        "}\n",
        encoding="utf-8",
    )
    res = client.get("/api/inventory")
    assert res.status_code == 200
    items = {r["address"]: r for r in res.json()["resources"]}
    assert "aws_instance.solr_extra" in items
    row = items["aws_instance.solr_extra"]
    assert row["state"] == "planned"
    assert row["managed"] is False
    assert row["component"] == "solr"


def test_managed_resource_has_managed_state(client, blueprint_env, monkeypatch):
    from devex_app.tofu import Resource

    monkeypatch.setattr(inv, "show_state", lambda root: {"ok": True})
    monkeypatch.setattr(
        inv,
        "resources_from_state",
        lambda state: [
            Resource(
                address="aws_vpc.main",
                type="aws_vpc",
                name="main",
                module="",
                provider="aws",
                mode="managed",
                values={"id": "vpc-1", "tags": {"Component": "network"}},
            )
        ],
    )
    row = client.get("/api/inventory").json()["resources"][0]
    assert row["state"] == "managed" and row["managed"] is True
