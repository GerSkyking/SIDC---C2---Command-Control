from test_flow import _make_map


def _plan(admin):
    _make_map(admin)
    return admin.post("/plans", json={"name": "Op Layer", "map_id": "m1"}).json()["id"]


def test_layer_crud(admin):
    pid = _plan(admin)
    r = admin.post(f"/plans/{pid}/layers", json={"name": "Logistik"})
    assert r.status_code in (200, 201)
    lid = r.json()["id"]
    assert admin.post(f"/plans/{pid}/layers", json={"name": "logistik"}).status_code == 409
    assert admin.post(f"/plans/{pid}/layers", json={"name": "BLUFOR"}).status_code in (400, 409, 422)
    assert any(x["id"] == lid for x in admin.get(f"/plans/{pid}/layers").json())
    assert admin.delete(f"/plans/{pid}/layers/{lid}").status_code == 200


def test_zeus_release(admin):
    pid = _plan(admin)
    snap = admin.get(f"/plans/{pid}/snapshot").json()
    bph = next(p for p in snap["phases"] if p["plane"] == "builder")
    r = admin.patch(f"/plans/{pid}/phases/{bph['id']}", json={"zeus_released": True})
    assert r.status_code == 200
    out = r.json()
    assert out["zeus_released"] and out["zeus_until"]
    r = admin.patch(f"/plans/{pid}/phases/{bph['id']}", json={"zeus_released": True, "zeus_hours": 0})
    assert r.json()["zeus_until"] is None
    r = admin.patch(f"/plans/{pid}/phases/{bph['id']}", json={"zeus_released": False})
    assert not r.json()["zeus_released"]
