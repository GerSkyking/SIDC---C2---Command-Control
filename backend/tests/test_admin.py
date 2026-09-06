"""Admin: lokale User + Gruppen, Katalog-Upload, Favoriten."""
import io
import json


def test_user_and_group_management(admin):
    r = admin.post("/api/admin/users", json={
        "username": "platoon1", "password": "platoon1-pass-xx", "can_create_plans": True,
    })
    assert r.status_code == 201
    uid = r.json()["id"]

    assert any(u["username"] == "platoon1" for u in admin.get("/api/admin/users").json())

    r = admin.patch(f"/api/admin/users/{uid}", json={"can_create_plans": False, "is_active": False})
    assert r.json()["can_create_plans"] is False and r.json()["is_active"] is False

    g = admin.post("/api/admin/groups", json={"name": "Platoon 1", "can_create_plans": True})
    assert g.status_code == 201
    gid = g.json()["id"]
    r = admin.put(f"/api/admin/groups/{gid}/members", json=[uid])
    assert r.json()["member_ids"] == [uid]

    assert admin.delete(f"/api/admin/users/{uid}").json()["ok"] is True


def test_admin_cannot_lock_self(admin):
    me = admin.get("/auth/me").json()
    assert admin.patch(f"/api/admin/users/{me['id']}", json={"is_active": False}).status_code == 400
    assert admin.patch(f"/api/admin/users/{me['id']}", json={"role": "user"}).status_code == 400


def test_catalog_upload_and_fetch(admin):
    doc = {"markers": [{"name": "Rifle", "sidc": "100140000011010100000000000000"}]}
    r = admin.post(
        "/api/admin/catalog/all-markers",
        files={"file": ("SIDC_AllMarkersCatalog.json", io.BytesIO(json.dumps(doc).encode()), "application/json")},
    )
    assert r.status_code == 200
    assert admin.get("/api/catalog").json()["all-markers"] is True
    assert admin.get("/api/catalog/all-markers").json() == doc
    admin.delete("/api/admin/catalog/all-markers")
    assert admin.get("/api/catalog/all-markers").status_code == 404


def test_favorites(admin):
    r = admin.post("/api/favorites", json={"label": "Mein MG", "sidc": "100130000011000000000000000000"})
    assert r.status_code == 201
    fid = r.json()["id"]
    assert len(admin.get("/api/favorites").json()) == 1
    assert admin.delete(f"/api/favorites/{fid}").json()["ok"] is True
