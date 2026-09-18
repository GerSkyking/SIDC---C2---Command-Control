"""Admin: lokale User + Gruppen, Katalog-Upload, Favoriten."""

import io
import json
import zipfile

from fastapi.testclient import TestClient

from app.main import app


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
        content=json.dumps(doc),
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 200
    assert admin.get("/api/catalog").json()["all-markers"] is True
    assert admin.get("/api/catalog/all-markers").json() == doc
    admin.delete("/api/admin/catalog/all-markers")
    assert admin.get("/api/catalog/all-markers").status_code == 404


def test_legal_upload_and_fetch(admin, client):
    assert client.get("/api/legal/imprint").json() == {"content": None}

    r = admin.post(
        "/api/admin/legal/imprint",
        content="# Impressum\n\nMax Mustermann",
        headers={"content-type": "text/plain; charset=utf-8"},
    )
    assert r.status_code == 200

    # ohne Login lesbar — Pflichtseite
    assert client.get("/api/legal/imprint").json() == {"content": "# Impressum\n\nMax Mustermann"}
    assert client.get("/api/legal/privacy").json() == {"content": None}

    admin.delete("/api/admin/legal/imprint")
    assert client.get("/api/legal/imprint").json() == {"content": None}

    assert admin.get("/api/legal/unknown").status_code == 404


def test_self_export_and_delete(admin):
    r = admin.post("/api/admin/users", json={
        "username": "leaver", "password": "leaver-pass-1234", "can_create_plans": True,
    })
    assert r.status_code == 201

    with TestClient(app) as c:
        c.post("/auth/login", json={"username": "leaver", "password": "leaver-pass-1234"})
        c.post("/api/favorites", json={"label": "MG", "sidc": "100130000011000000000000000000"})

        exp = c.get("/auth/me/export")
        assert exp.status_code == 200
        assert exp.headers["content-type"] == "application/zip"
        zf = zipfile.ZipFile(io.BytesIO(exp.content))
        names = set(zf.namelist())
        assert {"profile.json", "favorites.json", "plan_access.json",
                "plans_created.json", "created_content.json", "audit_log.json"} <= names
        profile = json.loads(zf.read("profile.json"))
        assert profile["username"] == "leaver"
        favs = json.loads(zf.read("favorites.json"))
        assert favs[0]["label"] == "MG"

        assert c.delete("/auth/me").json()["ok"] is True
        assert c.get("/auth/me").status_code == 401
        # Session-Cookie ungültig nach Löschung, erneuter Login unmöglich
        bad = c.post("/auth/login", json={"username": "leaver", "password": "leaver-pass-1234"})
        assert bad.status_code == 401

    assert not any(u["username"] == "leaver" for u in admin.get("/api/admin/users").json())


def test_last_admin_cannot_self_delete(admin):
    assert admin.delete("/auth/me").status_code == 400
    assert admin.get("/auth/me").status_code == 200


def test_audit_log_purge_old():
    from datetime import timedelta

    from app.audit import purge_old
    from app.db import SessionLocal
    from app.models import AuditLog, now

    with SessionLocal() as db:
        db.add(AuditLog(action="old.entry", ts=now() - timedelta(days=200)))
        db.add(AuditLog(action="recent.entry", ts=now() - timedelta(days=5)))
        db.commit()

        assert purge_old(db, 0) == 0  # deaktiviert -> no-op
        deleted = purge_old(db, 180)
        assert deleted >= 1
        remaining = [a.action for a in db.query(AuditLog).all()]
        assert "old.entry" not in remaining
        assert "recent.entry" in remaining


def test_favorites(admin):
    r = admin.post("/api/favorites", json={"label": "Mein MG", "sidc": "100130000011000000000000000000"})
    assert r.status_code == 201
    fid = r.json()["id"]
    assert len(admin.get("/api/favorites").json()) == 1
    assert admin.delete(f"/api/favorites/{fid}").json()["ok"] is True
