"""Review 2026-10: ORBAT-Hierarchie, Gruppen-Eindeutigkeit, Audit-Filter, Logout, Ratelimit."""

import time

from app import ratelimit


def _orbat(admin):
    oid = admin.post("/api/orbats", json={"name": "T"}).json()["id"]
    a = admin.post(f"/api/orbats/{oid}/nodes", json={"name": "A"}).json()["id"]
    b = admin.post(f"/api/orbats/{oid}/nodes", json={"name": "B", "parent_id": a}).json()["id"]
    return oid, a, b


def test_patch_node_rejects_cycles_and_null(admin):
    oid, a, b = _orbat(admin)
    # A unter seinen eigenen Nachfahren B → Zyklus
    assert admin.patch(f"/api/orbats/{oid}/nodes/{a}", json={"parent_id": b}).status_code == 400
    # unbekanntes Elter
    assert admin.patch(f"/api/orbats/{oid}/nodes/{a}", json={"parent_id": "nope"}).status_code == 404
    # null in NOT-NULL-Spalten → kein 500, Wert bleibt
    r = admin.patch(f"/api/orbats/{oid}/nodes/{b}", json={"name": None, "qty_planned": None})
    assert r.status_code == 200 and r.json()["name"] == "B"
    # parent_id = null (Wurzel) bleibt erlaubt
    assert admin.patch(f"/api/orbats/{oid}/nodes/{b}", json={"parent_id": None}).status_code == 200
    # Längenlimit statt DataError
    assert admin.patch(f"/api/orbats/{oid}/nodes/{b}", json={"name": "x" * 500}).status_code == 422


def test_group_rename_conflict_and_audit_filters(admin):
    g1 = admin.post("/api/admin/groups", json={"name": "G-one"}).json()["id"]
    admin.post("/api/admin/groups", json={"name": "G-two"})
    assert admin.patch(f"/api/admin/groups/{g1}", json={"name": "G-two"}).status_code == 409
    assert admin.patch(f"/api/admin/groups/{g1}", json={"name": "G-one"}).status_code == 200
    r = admin.get("/api/admin/audit?offset=-5&user=does-not-exist")
    assert r.status_code == 200 and r.json()["items"] == []
    assert admin.get("/api/admin/audit?offset=-5").status_code == 200


def test_logout_keeps_other_devices_logged_in(client):
    from fastapi.testclient import TestClient

    from app.main import app
    from app.security import SESSION_COOKIE

    client.post("/auth/login", json={"username": "admin", "password": "test-admin-pass-123"})
    stolen = client.cookies.get(SESSION_COOKIE)
    assert stolen
    client.post("/auth/logout")
    with TestClient(app) as c2:
        c2.cookies.set(SESSION_COOKIE, stolen)
        assert c2.get("/auth/me").status_code == 200  # Logout betrifft nur diesen Browser, andere Geräte bleiben angemeldet

def test_ratelimit_sweeps_expired_keys():
    ratelimit._hits.clear()
    ratelimit._windows.clear()
    ratelimit._hit("k", 5, 0.01)
    time.sleep(0.05)
    ratelimit._last_sweep = 0.0
    ratelimit._hit("other", 5, 60)
    assert "k" not in ratelimit._hits

