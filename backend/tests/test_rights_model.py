"""Rechtemodell: Admin ≠ Zeus/Missionsbau, Techniker, Kartenverwalter, Gruppe „public“, Projekt-Missionsbau."""
import itertools

from fastapi.testclient import TestClient

from app.main import app

PW = "pw-1234567890"
_n = itertools.count(1)


def _name(p="r"):
    return f"{p}{next(_n)}x"


def _user(admin, name=None, **flags):
    name = name or _name()
    r = admin.post("/api/admin/users", json={"username": name, "password": PW, "role": flags.pop("role", "user"), **flags})
    assert r.status_code == 201, r.text
    c = TestClient(app)
    assert c.post("/auth/login", json={"username": name, "password": PW}).status_code == 200
    return c, r.json()["id"]


def test_admin_has_no_implicit_builder_or_zeus(admin):
    a, _ = _user(admin, role="admin")
    me = a.get("/auth/me").json()
    assert me["role"] == "admin" and me["is_staff"] is True
    assert me["is_mission_builder_effective"] is False and me["is_zeus_effective"] is False
    assert a.post("/projects", json={"name": "x"}).status_code == 403


def test_technician_sees_users_but_cannot_change_rights(admin):
    t, _ = _user(admin, is_technician=True)
    u, uid = _user(admin)
    assert t.get("/api/admin/users").status_code == 200
    assert t.get("/api/admin/groups").status_code == 200
    assert t.get("/api/admin/maps/storage").status_code == 200
    assert t.patch(f"/api/admin/users/{uid}", json={"is_zeus": True}).status_code == 403
    assert t.post("/api/admin/users", json={"username": _name(), "password": PW}).status_code == 403
    assert t.get("/api/admin/audit").status_code == 403
    assert u.get("/api/admin/users").status_code == 403


def test_non_local_admin_cannot_grant_rights(admin):
    """OIDC-Admins (mit OidcIdentity) vergeben keine Rechte."""
    from app.db import SessionLocal
    from app.models import OidcIdentity

    a, aid = _user(admin, role="admin")
    _, uid = _user(admin)
    assert a.patch(f"/api/admin/users/{uid}", json={"can_manage_maps": True}).status_code == 200
    with SessionLocal() as db:
        db.add(OidcIdentity(user_id=aid, issuer="https://idp.test", subject="s-" + aid))
        db.commit()
    assert a.patch(f"/api/admin/users/{uid}", json={"is_zeus": True}).status_code == 403
    assert a.get("/auth/me").json()["can_grant_rights"] is False


def test_map_manager_without_admin(admin):
    mm, _ = _user(admin, can_manage_maps=True)
    plain, _ = _user(admin)
    assert mm.get("/auth/me").json()["can_manage_maps_effective"] is True
    r = mm.post("/api/maps", json={"id": "mm1", "name": "M", "url": "http://x.invalid/a.zip"})
    assert r.status_code in (200, 201, 202), r.text
    assert plain.post("/api/maps", json={"id": "mm2", "name": "M", "url": "http://x.invalid/a.zip"}).status_code == 403


def test_group_rights_rules(admin):
    t, tid = _user(admin, is_technician=True)
    r = t.post("/api/admin/groups", json={"name": _name("g")})
    assert r.status_code == 201, r.text
    gid = r.json()["id"]
    # Techniker darf Gruppe ohne Rechte anlegen, aber keine Rechte setzen
    assert t.post("/api/admin/groups", json={"name": _name("g"), "is_zeus": True}).status_code == 403
    assert t.patch(f"/api/admin/groups/{gid}", json={"name": "umbenannt", "is_zeus": True}).status_code == 403
    # Mitglieder rechtefreier Gruppen darf der Techniker setzen
    _, uid = _user(admin)
    assert t.put(f"/api/admin/groups/{gid}/members", json=[uid]).status_code == 200
    # Gruppenrechte nur lokaler Admin, der selbst Mitglied ist
    assert admin.patch(f"/api/admin/groups/{gid}", json={"name": "umbenannt", "is_zeus": True}).status_code == 403
    me = admin.get("/auth/me").json()
    assert admin.put(f"/api/admin/groups/{gid}/members", json=[uid, me["id"]]).status_code == 200
    assert admin.patch(f"/api/admin/groups/{gid}", json={"name": "umbenannt", "is_zeus": True}).status_code == 200
    # Mitglieder einer Gruppe mit Rechten: Techniker darf nicht (Selbst-Eskalation)
    assert t.put(f"/api/admin/groups/{gid}/members", json=[uid, tid]).status_code == 403


def test_public_group_is_system(admin):
    gs = {g["name"]: g for g in admin.get("/api/admin/groups").json()}
    g = gs["public"]
    assert g["is_system"] is True
    assert admin.patch(f"/api/admin/groups/{g['id']}", json={"name": "x"}).status_code == 409
    assert admin.delete(f"/api/admin/groups/{g['id']}").status_code == 409
    assert admin.put(f"/api/admin/groups/{g['id']}/members", json=[]).status_code == 409


def test_project_builder_flag_only_in_project(admin):
    mb, mbid = _user(admin, is_mission_builder=True)
    u, uid = _user(admin)
    pid = mb.post("/projects", json={"name": "P"}).json()["id"]
    r = mb.put(f"/projects/{pid}/members", json=[
        {"subject_type": "user", "subject_id": mbid, "role": "owner"},
        {"subject_type": "user", "subject_id": uid, "role": "editor", "is_builder": True},
    ])
    assert r.status_code == 200, r.text
    assert u.get(f"/projects/{pid}").json()["is_builder"] is True
    assert u.get("/auth/me").json()["is_mission_builder_effective"] is False
    # Projekt-MB kann (als Owner) das Flag nicht weitergeben
    u2, u2id = _user(admin)
    r = mb.put(f"/projects/{pid}/members", json=[
        {"subject_type": "user", "subject_id": mbid, "role": "owner"},
        {"subject_type": "user", "subject_id": uid, "role": "owner", "is_builder": True},
        {"subject_type": "user", "subject_id": u2id, "role": "viewer", "is_builder": True},
    ])
    assert r.status_code == 200
    rows = {m["subject_id"]: m for m in r.json()}
    assert rows[u2id]["is_builder"] is True  # globaler MB darf
    r = u.put(f"/projects/{pid}/members", json=[
        {"subject_type": "user", "subject_id": mbid, "role": "owner"},
        {"subject_type": "user", "subject_id": uid, "role": "owner", "is_builder": True},
        {"subject_type": "user", "subject_id": u2id, "role": "viewer", "is_builder": False},
        {"subject_type": "user", "subject_id": _user(admin)[1], "role": "viewer", "is_builder": True},
    ])
    assert r.status_code == 200
    rows = r.json()
    assert [m for m in rows if m["subject_id"] == u2id][0]["is_builder"] is True  # unverändert
    assert sum(1 for m in rows if m["is_builder"]) == 2  # neues Mitglied bekam kein Builder-Flag
