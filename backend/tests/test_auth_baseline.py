"""Ist-Stand der Anmeldung (WP-010): lokaler Login und OIDC-Rückruf ohne jede neue
Einstellung. Diese Tests liefen zuerst gegen den unveränderten Code und müssen ohne
die Einstellungen aus der Spec „Anmeldung und Zugriff“ unverändert grün bleiben."""

import uuid

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.main import app
from app.models import AuditLog, GroupMember, OidcIdentity, User


def _name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _user(username: str) -> User | None:
    with SessionLocal() as db:
        return db.scalar(select(User).where(User.username == username))


def _local_user(admin, **extra) -> tuple[str, str, str]:
    name, pw = _name("local"), "local-user-pass-123"
    r = admin.post("/api/admin/users", json={"username": name, "password": pw, **extra})
    assert r.status_code == 201
    return r.json()["id"], name, pw


# ─── Lokaler Login ─────────────────────────────────────────────────────────

def test_local_login_ok(client):
    r = client.post("/auth/login", json={"username": "admin", "password": "test-admin-pass-123"})
    assert r.status_code == 200
    assert r.json()["username"] == "admin" and r.json()["role"] == "admin"
    assert client.get("/auth/me").json()["username"] == "admin"
    with SessionLocal() as db:
        assert db.scalar(select(AuditLog).where(AuditLog.action == "login.ok", AuditLog.user_id == r.json()["id"]))


def test_local_login_normal_user_ok(admin):
    _, name, pw = _local_user(admin)
    with TestClient(app) as c:
        assert c.post("/auth/login", json={"username": name, "password": pw}).status_code == 200
        assert c.get("/auth/me").json()["username"] == name


def test_local_login_wrong_password(client):
    r = client.post("/auth/login", json={"username": "admin", "password": "falsch-falsch-falsch"})
    assert r.status_code == 401
    assert r.json()["detail"] == "Login fehlgeschlagen"
    assert client.get("/auth/me").status_code == 401


def test_local_login_unknown_user_same_message(client):
    r = client.post("/auth/login", json={"username": _name("niemand"), "password": "egal-egal-egal"})
    assert r.status_code == 401
    assert r.json()["detail"] == "Login fehlgeschlagen"


def test_local_login_deactivated_account(admin):
    uid, name, pw = _local_user(admin)
    admin.patch(f"/api/admin/users/{uid}", json={"is_active": False})
    with TestClient(app) as c:
        r = c.post("/auth/login", json={"username": name, "password": pw})
        assert r.status_code == 401
        assert r.json()["detail"] == "Login fehlgeschlagen"


def test_session_cookie_seven_days(client):
    r = client.post("/auth/login", json={"username": "admin", "password": "test-admin-pass-123"})
    cookie = r.headers["set-cookie"].lower()
    assert "max-age=604800" in cookie and "httponly" in cookie and "samesite=lax" in cookie


def test_logout_ends_session(client):
    client.post("/auth/login", json={"username": "admin", "password": "test-admin-pass-123"})
    assert client.post("/auth/logout").json() == {"ok": True}
    assert client.get("/auth/me").status_code == 401


# ─── OIDC ──────────────────────────────────────────────────────────────────

def test_oidc_off_by_default(client):
    assert client.get("/auth/oidc/enabled").json()["enabled"] is False
    assert client.get("/auth/oidc/login", follow_redirects=False).status_code == 404
    assert client.get("/auth/oidc/callback?code=x&state=y", follow_redirects=False).status_code == 404


def test_oidc_new_user_is_created(client, oidc):
    name, sub = _name("neu"), uuid.uuid4().hex
    r = oidc.callback(client, sub=sub, preferred_username=name, name="Neu Angelegt")
    assert r.status_code == 303 and r.headers["location"] == "/"
    assert "max-age=604800" in r.headers["set-cookie"].lower()

    me = client.get("/auth/me").json()
    assert me["username"] == name
    assert me["role"] == "user"
    assert me["can_create_plans"] is False
    assert me["is_mission_builder"] is False and me["is_zeus"] is False
    assert me["display_name"] == ""  # heute wird kein Anzeigename aus dem Token übernommen

    u = _user(name)
    assert u.password_hash is None
    with SessionLocal() as db:
        ident = db.scalar(select(OidcIdentity).where(OidcIdentity.user_id == u.id))
        assert (ident.issuer, ident.subject) == (oidc.issuer, sub)


def test_oidc_known_user_recognised_by_issuer_and_sub(client, oidc):
    name, sub = _name("bekannt"), uuid.uuid4().hex
    oidc.callback(client, sub=sub, preferred_username=name)
    first = client.get("/auth/me").json()["id"]

    with TestClient(app) as other:
        # anderer Name, andere E-Mail: zählt nicht, nur Aussteller + sub
        r = oidc.callback(other, sub=sub, preferred_username=_name("umbenannt"), email="x@example.test")
        assert r.status_code == 303
        me = other.get("/auth/me").json()
        assert me["id"] == first and me["username"] == name


def test_oidc_same_sub_other_issuer_is_other_user(client, oidc):
    sub = uuid.uuid4().hex
    oidc.callback(client, sub=sub, preferred_username=_name("a"))
    first = client.get("/auth/me").json()["id"]
    with TestClient(app) as other:
        oidc.callback(other, iss="https://anderer-idp.example.test/", sub=sub, preferred_username=_name("b"))
        assert other.get("/auth/me").json()["id"] != first


def test_oidc_same_name_does_not_link_to_existing_account(admin, oidc):
    """Ein gleichnamiges lokales Konto wird nicht übernommen; es entsteht ein neues Konto."""
    uid, name, _ = _local_user(admin)
    with TestClient(app) as c:
        oidc.callback(c, sub=uuid.uuid4().hex, preferred_username=name)
        me = c.get("/auth/me").json()
        assert me["id"] != uid and me["username"] == f"{name}-2"


def test_oidc_username_falls_back_to_email_local_part(client, oidc):
    local = _name("mail")
    oidc.callback(client, sub=uuid.uuid4().hex, email=f"{local}@example.test")
    assert client.get("/auth/me").json()["username"] == local


def test_oidc_username_falls_back_to_sub(client, oidc):
    sub = uuid.uuid4().hex
    oidc.callback(client, sub=sub)
    assert client.get("/auth/me").json()["username"] == f"oidc-{sub[:8]}"


def test_oidc_deactivated_user_is_rejected(admin, oidc):
    name, sub = _name("gesperrt"), uuid.uuid4().hex
    with TestClient(app) as c:
        oidc.callback(c, sub=sub, preferred_username=name)
        uid = c.get("/auth/me").json()["id"]
    admin.patch(f"/api/admin/users/{uid}", json={"is_active": False})
    with TestClient(app) as c:
        r = oidc.callback(c, sub=sub, preferred_username=name)
        assert r.status_code == 403
        assert r.json()["detail"] == "Konto deaktiviert"
        assert c.get("/auth/me").status_code == 401


def test_oidc_token_without_sub_is_rejected(client, oidc):
    r = oidc.callback(client, preferred_username=_name("ohnesub"))
    assert r.status_code == 400


def test_oidc_new_user_gets_default_group(admin, oidc, monkeypatch):
    from app.config import get_settings

    gname = _name("alle")
    gid = admin.post("/api/admin/groups", json={"name": gname, "can_create_plans": True}).json()["id"]
    monkeypatch.setattr(get_settings(), "default_user_group", gname)

    name = _name("mitgruppe")
    with TestClient(app) as c:
        oidc.callback(c, sub=uuid.uuid4().hex, preferred_username=name)
        me = c.get("/auth/me").json()
        assert me["can_create_plans"] is False and me["can_create_plans_effective"] is True
    with SessionLocal() as db:
        assert db.scalar(select(GroupMember).where(GroupMember.group_id == gid, GroupMember.user_id == me["id"]))


def test_oidc_login_keeps_manually_granted_rights(admin, oidc):
    """Ohne Zuordnung von Gruppen fasst ein OIDC-Login die Rechte im Tool nicht an."""
    name, sub = _name("hand"), uuid.uuid4().hex
    with TestClient(app) as c:
        oidc.callback(c, sub=sub, preferred_username=name)
        uid = c.get("/auth/me").json()["id"]
    r = admin.patch(f"/api/admin/users/{uid}", json={
        "role": "admin", "is_mission_builder": True, "is_zeus": True, "can_create_plans": True,
        "display_name": "Von Hand",
    })
    assert r.status_code == 200
    with TestClient(app) as c:
        oidc.callback(c, sub=sub, preferred_username=name, name="Aus dem Token", groups=["irgendwas"])
        me = c.get("/auth/me").json()
        assert me["role"] == "admin" and me["is_mission_builder"] and me["is_zeus"] and me["can_create_plans"]
        assert me["display_name"] == "Von Hand"
