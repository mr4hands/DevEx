def test_flat_layout_patch_is_gone(client, blueprint_env):
    res = client.patch("/api/blueprint/layout", json={"positions": {}})
    assert res.status_code in (404, 405)


def test_flat_resource_delete_is_gone(client, blueprint_env):
    res = client.request("DELETE", "/api/blueprint/resource/aws_vpc/main", json={})
    assert res.status_code in (404, 405)
