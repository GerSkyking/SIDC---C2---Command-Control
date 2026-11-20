"""Regeln der Spec „Anmeldung und Zugriff“ (docs/specs/anmeldung-und-zugriff.md).

Jeder Test schaltet die nötige Einstellung selbst ein; die Gruppennamen hier sind frei
gewählt (im Code stehen keine, ADR 0003). Der Lauf ohne Einstellungen steht in
``test_auth_baseline.py``."""

import time
import uuid
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.config import get_settings
from app.db import SessionLocal
from app.main import app
from app.models import AuditLog, OidcIdentity, User

ADMIN_PW = "test-admin-pass-123"


def _name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _db_user(user_id: str) -> User:
    with SessionLocal() as db:
        return db.get(User, user_id)


def _audit(action: str, user_id: str | None = None) -> list[AuditLog]:
    with SessionLocal() as db:
        q = select(AuditLog).where(AuditLog.action == action)
        if user_id is not None:
            q = q.where(AuditLog.user_id == user_id)
        return list(db.scalars(q))


def _oidc_user(oidc, **claims) -> tuple[str, str, str]:
    """Person über OIDC anmelden; gibt (user_id, sub, username) zurück."""
    sub = claims.pop("sub", None) or uuid.uuid4().hex
    name = claims.pop("preferred_username", None) or _name("oidc")
    with TestClient(app) as c:
        r = oidc.callback(c, sub=sub, preferred_username=name, **claims)
        assert r.status_code == 303 and r.headers["location"] == "/", r.text
        return c.get("/auth/me").json()["id"], sub, name


def _local_user(admin, **extra) -> tuple[str, str, str]:
    name, pw = _name("local"), "local-user-pass-123"
    r = admin.post("/api/admin/users", json={"username": name, "password": pw, **extra})
    assert r.status_code == 201
    return r.json()["id"], name, pw


# ─── Einstellungen ─────────────────────────────────────────────────────────

def test_einstellungen_standard_ist_das_bisherige_verhalten(monkeypatch):
    """ADR 0003: Ohne neue Einstellungen (auch leer durchgereicht) ändert sich nichts."""
    from app import oidc_access
    from app.config import Settings

    names = ("SESSION_TTL_HOURS", "LOCAL_LOGIN", "OIDC_SCOPES", "OIDC_GROUPS_CLAIM", "OIDC_REQUIRED_GROUPS",
             "OIDC_ADMIN_GROUPS", "OIDC_MISSION_BUILDER_GROUPS", "OIDC_ZEUS_GROUPS", "OIDC_CREATE_PLANS_GROUPS",
             "OIDC_TECHNICIAN_GROUPS", "OIDC_MANAGE_MAPS_GROUPS", "OIDC_SYNC_DISPLAY_NAME")
    for empty in (False, True):
        for name in names:
            monkeypatch.setenv(name, "") if empty else monkeypatch.delenv(name, raising=False)
        s = Settings(_env_file=None)
        assert s.local_login == "all"
        assert s.session_ttl_seconds() == 7 * 86400
        assert s.oidc_scopes == "openid email profile" and s.oidc_groups_claim == "groups"
        assert s.oidc_sync_display_name is False
        assert oidc_access.required_groups(s) == set() and oidc_access.right_groups(s) == {}
        assert oidc_access.has_access(set(), s) is True


def test_einstellungen_listen_kommagetrennt(monkeypatch):
    from app import oidc_access
    from app.config import Settings

    monkeypatch.setenv("OIDC_ADMIN_GROUPS", " chefs ,vize-chefs,, ")
    monkeypatch.setenv("LOCAL_LOGIN", "bootstrap-admin")
    monkeypatch.setenv("SESSION_TTL_HOURS", "24")
    s = Settings(_env_file=None)
    assert oidc_access.right_groups(s) == {"role": {"chefs", "vize-chefs"}}
    assert s.local_login == "bootstrap-admin" and s.session_ttl_seconds() == 86400


# ─── AUTH-R-001 / AUTH-R-002: ein Anmeldeweg, Notfallzugang ────────────────

def test_auth_r_001_anmeldeseite_erfaehrt_den_modus(client, cfg, oidc):
    assert client.get("/auth/oidc/enabled").json() == {"enabled": True, "local_login": "all"}
    cfg(local_login="bootstrap-admin")
    assert client.get("/auth/oidc/enabled").json() == {"enabled": True, "local_login": "bootstrap-admin"}


def test_auth_r_001_name_des_anmeldedienstes(client, cfg, oidc):
    """Ohne Einstellung fehlt das Feld (Texte wie bisher); gesetzt wird der Name geliefert,
    höchstens 40 Zeichen, ohne Steuerzeichen und überzähligen Leerraum."""
    assert "provider_name" not in client.get("/auth/oidc/enabled").json()
    cfg(oidc_provider_name="   ")
    assert "provider_name" not in client.get("/auth/oidc/enabled").json()

    cfg(oidc_provider_name="Beispiel-Dienst")
    assert client.get("/auth/oidc/enabled").json() == {
        "enabled": True, "local_login": "all", "provider_name": "Beispiel-Dienst",
    }
    cfg(oidc_provider_name="  Mein\n\tDienst <b>  ")
    assert client.get("/auth/oidc/enabled").json()["provider_name"] == "Mein Dienst <b>"

    cfg(oidc_provider_name="x" * 39 + " " + "y" * 20)
    assert client.get("/auth/oidc/enabled").json()["provider_name"] == "x" * 39
    cfg(oidc_provider_name="z" * 200)
    assert client.get("/auth/oidc/enabled").json()["provider_name"] == "z" * 40


def test_auth_r_001_name_des_anmeldedienstes_aus_der_umgebung(monkeypatch):
    from app.config import Settings

    monkeypatch.delenv("OIDC_PROVIDER_NAME", raising=False)
    assert Settings(_env_file=None).oidc_provider_label() == ""
    monkeypatch.setenv("OIDC_PROVIDER_NAME", "")
    assert Settings(_env_file=None).oidc_provider_label() == ""
    monkeypatch.setenv("OIDC_PROVIDER_NAME", "Beispiel-Dienst")
    assert Settings(_env_file=None).oidc_provider_label() == "Beispiel-Dienst"


def test_auth_r_002_lokal_nur_start_admin(admin, cfg):
    _, name, pw = _local_user(admin)
    cfg(local_login="bootstrap-admin")
    with TestClient(app) as c:
        r = c.post("/auth/login", json={"username": name, "password": pw})
        assert r.status_code == 401
        # dieselbe neutrale Meldung wie bei falschem Passwort
        assert r.json()["detail"] == "Login fehlgeschlagen"
        assert c.get("/auth/me").status_code == 401
        assert any(a.detail.get("username") == name for a in _audit("login.fail"))

        r = c.post("/auth/login", json={"username": "admin", "password": ADMIN_PW})
        assert r.status_code == 200 and r.json()["role"] == "admin"


def test_auth_r_002_abgelehnter_lokaler_login_rechnet_argon2(admin, cfg, monkeypatch):
    """Auch im Notfallmodus läuft für jedes Konto ein Argon2-Verify (gleiche Antwortzeit)."""
    from app.routers import auth

    _, name, pw = _local_user(admin)
    cfg(local_login="bootstrap-admin")
    calls = []
    real = auth.verify_password
    monkeypatch.setattr(auth, "verify_password", lambda p, h: calls.append(1) or real(p, h))
    with TestClient(app) as c:
        assert c.post("/auth/login", json={"username": name, "password": pw}).status_code == 401
        assert c.post("/auth/login", json={"username": _name("niemand"), "password": pw}).status_code == 401
    assert len(calls) == 2


def test_auth_r_002_start_admin_meldet_sich_ohne_provider_an(client, cfg):
    """Notfallzugang: funktioniert, auch wenn OIDC gar nicht erreichbar oder eingerichtet ist."""
    cfg(local_login="bootstrap-admin")
    assert client.get("/auth/oidc/enabled").json()["enabled"] is False
    assert client.post("/auth/login", json={"username": "admin", "password": ADMIN_PW}).status_code == 200


def test_auth_r_013_lokale_anmeldung_steht_im_protokoll(client):
    before = len(_audit("login.ok"))
    r = client.post("/auth/login", json={"username": "admin", "password": ADMIN_PW})
    entries = _audit("login.ok", r.json()["id"])
    assert len(_audit("login.ok")) == before + 1
    assert entries[-1].detail.get("method") == "local"
    assert "password" not in str(entries[-1].detail).lower()


# ─── AUTH-R-003 / AUTH-R-009: Zugangsgruppe ────────────────────────────────

def test_auth_r_003_ohne_gruppe_kein_zugang_und_kein_konto(client, cfg, oidc):
    cfg(oidc_required_groups="members, guests")
    name, sub = _name("fremd"), uuid.uuid4().hex
    denied_before = len(_audit("oidc.denied"))

    r = oidc.callback(client, sub=sub, preferred_username=name, groups=["andere"])
    assert r.status_code == 303 and r.headers["location"] == "/?auth=denied"
    assert "sidc_session" not in r.headers.get("set-cookie", "")
    assert client.get("/auth/me").status_code == 401
    with SessionLocal() as db:
        assert db.scalar(select(User).where(User.username == name)) is None
        assert db.scalar(select(OidcIdentity).where(OidcIdentity.subject == sub)) is None

    entries = _audit("oidc.denied")
    assert len(entries) == denied_before + 1
    detail = entries[-1].detail
    assert detail["reason"] == "missing_group" and detail["known"] is False
    assert sub not in str(detail) and name not in str(detail)  # weder Token noch Claims im Protokoll


def test_auth_r_003_token_ohne_gruppen_claim_wird_abgelehnt(client, cfg, oidc):
    cfg(oidc_required_groups="members")
    r = oidc.callback(client, sub=uuid.uuid4().hex, preferred_username=_name("ohne"))
    assert r.headers["location"] == "/?auth=denied"


def test_auth_r_003_eine_der_zugangsgruppen_reicht(client, cfg, oidc):
    cfg(oidc_required_groups="members,guests")
    r = oidc.callback(client, sub=uuid.uuid4().hex, preferred_username=_name("gast"), groups=["x", "guests"])
    assert r.status_code == 303 and r.headers["location"] == "/"
    assert client.get("/auth/me").status_code == 200
    assert _audit("oidc.user_create", client.get("/auth/me").json()["id"])  # AUTH-R-013: erstes Anlegen


def test_auth_r_003_eigener_name_des_gruppen_claims(client, cfg, oidc):
    cfg(oidc_required_groups="members", oidc_groups_claim="roles")
    r = oidc.callback(client, sub=uuid.uuid4().hex, preferred_username=_name("a"), groups=["members"])
    assert r.headers["location"] == "/?auth=denied"
    r = oidc.callback(client, sub=uuid.uuid4().hex, preferred_username=_name("b"), roles=["members"])
    assert r.headers["location"] == "/"


def test_auth_r_009_verlust_der_zugangsgruppe_deaktiviert_und_rueckkehr_aktiviert(client, cfg, oidc):
    cfg(oidc_required_groups="members")
    name, sub = _name("mitglied"), uuid.uuid4().hex
    assert oidc.callback(client, sub=sub, preferred_username=name, groups=["members"]).headers["location"] == "/"
    uid = client.get("/auth/me").json()["id"]

    with TestClient(app) as other:
        r = oidc.callback(other, sub=sub, preferred_username=name, groups=[])
        assert r.headers["location"] == "/?auth=denied"
    u = _db_user(uid)
    assert u.is_active is False and u.deactivated_by_sync is True
    assert client.get("/auth/me").status_code == 401  # die laufende Sitzung endet sofort
    assert _audit("oidc.deactivate", uid)

    with TestClient(app) as back:
        r = oidc.callback(back, sub=sub, preferred_username=name, groups=["members"])
        assert r.headers["location"] == "/"
        assert back.get("/auth/me").json()["id"] == uid
    u = _db_user(uid)
    assert u.is_active is True and u.deactivated_by_sync is False
    assert _audit("oidc.reactivate", uid)
    assert client.get("/auth/me").status_code == 401  # alte Sitzung lebt nicht wieder auf


def test_auth_r_009_vom_admin_deaktiviert_bleibt_deaktiviert(admin, cfg, oidc):
    cfg(oidc_required_groups="members")
    uid, sub, name = _oidc_user(oidc, groups=["members"])
    assert admin.patch(f"/api/admin/users/{uid}", json={"is_active": False}).status_code == 200

    with TestClient(app) as c:
        r = oidc.callback(c, sub=sub, preferred_username=name, groups=["members"])
        assert r.status_code == 403 and r.json()["detail"] == "Konto deaktiviert"
    assert _db_user(uid).is_active is False


def test_auth_r_009_admin_entscheidung_schlaegt_abgleich(admin, cfg, oidc):
    """Hat der Abgleich deaktiviert und der Admin danach selbst deaktiviert, hebt eine
    zurückgekehrte Gruppe das nicht mehr auf."""
    cfg(oidc_required_groups="members")
    uid, sub, name = _oidc_user(oidc, groups=["members"])
    with TestClient(app) as c:
        oidc.callback(c, sub=sub, preferred_username=name, groups=[])
    assert _db_user(uid).deactivated_by_sync is True
    admin.patch(f"/api/admin/users/{uid}", json={"is_active": True})
    admin.patch(f"/api/admin/users/{uid}", json={"is_active": False})
    assert _db_user(uid).deactivated_by_sync is False
    with TestClient(app) as c:
        assert oidc.callback(c, sub=sub, preferred_username=name, groups=["members"]).status_code == 403


def test_auth_r_009_start_admin_wird_nie_deaktiviert(admin, cfg, oidc):
    """AUTH-R-010: Ist der Start-Admin verknüpft und fehlt die Gruppe, wird der Login
    abgelehnt, das Konto aber nicht deaktiviert (Notfallzugang bleibt)."""
    me = admin.get("/auth/me").json()
    sub = uuid.uuid4().hex
    with SessionLocal() as db:
        db.add(OidcIdentity(user_id=me["id"], issuer=oidc.issuer, subject=sub))
        db.commit()
    try:
        cfg(oidc_required_groups="members", oidc_admin_groups="chefs")
        with TestClient(app) as c:
            assert oidc.callback(c, sub=sub, groups=[]).headers["location"] == "/?auth=denied"
        assert _db_user(me["id"]).is_active is True
        assert admin.get("/auth/me").status_code == 200
        # mit Zugang, aber ohne Admin-Gruppe: bleibt trotzdem Admin
        with TestClient(app) as c:
            assert oidc.callback(c, sub=sub, groups=["members"]).headers["location"] == "/"
            assert c.get("/auth/me").json()["role"] == "admin"
    finally:
        with SessionLocal() as db:
            db.query(OidcIdentity).filter(OidcIdentity.subject == sub).delete()
            db.commit()


# ─── AUTH-R-004: Wiedererkennen ────────────────────────────────────────────

def test_auth_r_004_nur_aussteller_und_sub_zaehlen(admin, cfg, oidc):
    cfg(oidc_sync_display_name=True)
    local_id, local_name, _ = _local_user(admin, display_name="Gleicher Name")
    uid, sub, name = _oidc_user(oidc, preferred_username=local_name, name="Gleicher Name")
    assert uid != local_id  # gleicher Login- und Anzeigename verknüpft nichts
    with TestClient(app) as c:
        oidc.callback(c, sub=sub, preferred_username=_name("neuername"), name="Anders")
        assert c.get("/auth/me").json()["id"] == uid
    with TestClient(app) as c:
        oidc.callback(c, sub=uuid.uuid4().hex, preferred_username=name, name="Gleicher Name")
        assert c.get("/auth/me").json()["id"] not in (uid, local_id)


# ─── AUTH-R-005: Anzeigename ───────────────────────────────────────────────

def test_auth_r_005_anzeigename_aus_dem_token_bei_jedem_login(client, cfg, oidc):
    cfg(oidc_sync_display_name=True)
    name, sub = _name("anzeige"), uuid.uuid4().hex
    oidc.callback(client, sub=sub, preferred_username=name, name="Pvt. Erster Name")
    assert client.get("/auth/me").json()["display_name"] == "Pvt. Erster Name"

    # selbst gesetzter Name wird beim nächsten Login überschrieben (passt zum Namen beim Provider)
    client.patch("/auth/me", json={"display_name": "Selbst gesetzt"})
    oidc.callback(client, sub=sub, preferred_username=name, name="Cpl. Neuer Name")
    me = client.get("/auth/me").json()
    assert me["display_name"] == "Cpl. Neuer Name" and me["username"] == name


def test_auth_r_005_rueckfall_auf_preferred_username_und_bereinigung(client, cfg, oidc):
    cfg(oidc_sync_display_name=True)
    name, sub = _name("rueckfall"), uuid.uuid4().hex
    oidc.callback(client, sub=sub, preferred_username=name)
    assert client.get("/auth/me").json()["display_name"] == name
    oidc.callback(client, sub=sub, preferred_username=name, name='<b>"Böse"</b> & Co')
    assert client.get("/auth/me").json()["display_name"] == "bBöse/b  Co"


# ─── AUTH-R-006: Datensparsamkeit ──────────────────────────────────────────

def test_auth_r_006_scopes_kommen_aus_der_einstellung(cfg):
    from authlib.integrations.starlette_client import OAuth

    from app.routers import auth

    s = get_settings()
    cfg(oidc_issuer="https://idp.example.test/application/o/c2/", oidc_client_id="c2")
    oauth = OAuth()
    auth._register_oidc(oauth, s)
    assert oauth.oidc.client_kwargs["scope"] == "openid email profile"  # Standard wie bisher

    cfg(oidc_scopes="openid  profile groups")
    oauth = OAuth()
    auth._register_oidc(oauth, s)
    assert oauth.oidc.client_kwargs["scope"] == "openid profile groups"
    assert "email" not in oauth.oidc.client_kwargs["scope"]


def test_auth_r_006_email_nie_als_login_name_wenn_nicht_angefordert(client, cfg, oidc):
    cfg(oidc_scopes="openid profile")
    sub, local = uuid.uuid4().hex, _name("geheim")
    # der Provider schickt die E-Mail trotzdem mit: sie wird nicht verwendet
    oidc.callback(client, sub=sub, email=f"{local}@example.test", name="Ohne Mail")
    me = client.get("/auth/me").json()
    assert me["username"] == f"oidc-{sub[:8]}"
    with SessionLocal() as db:
        u = db.get(User, me["id"])
        assert local not in u.username and local not in (u.display_name or "")


def test_auth_r_006_login_name_aus_preferred_username(client, cfg, oidc):
    cfg(oidc_scopes="openid profile")
    name = _name("pref")
    oidc.callback(client, sub=uuid.uuid4().hex, preferred_username=name, email="x@example.test")
    assert client.get("/auth/me").json()["username"] == name


# ─── AUTH-R-007 / -008 / -010: Rechte aus Gruppen ──────────────────────────

RIGHTS = dict(
    oidc_admin_groups="chefs, vize-chefs",
    oidc_mission_builder_groups="bauer",
    oidc_zeus_groups="zeuse",
    oidc_create_plans_groups="members",
)


def test_auth_r_007_gruppen_verleihen_rechte(client, cfg, oidc):
    cfg(**RIGHTS)
    oidc.callback(client, sub=uuid.uuid4().hex, preferred_username=_name("bauer"), groups=["members", "bauer"])
    me = client.get("/auth/me").json()
    assert me["role"] == "user" and me["is_mission_builder"] is True
    assert me["is_zeus"] is False and me["can_create_plans"] is True


def test_auth_r_007_mehrere_gruppen_je_recht(client, cfg, oidc):
    cfg(**RIGHTS)
    for group in ("chefs", "vize-chefs"):
        with TestClient(app) as c:
            oidc.callback(c, sub=uuid.uuid4().hex, preferred_username=_name(group), groups=[group])
            assert c.get("/auth/me").json()["role"] == "admin"


def test_auth_r_007_techniker_und_karten_sind_getrennte_gruppen(cfg, oidc):
    """Jede Gruppe verleiht nur ihr eigenes Recht: Techniker schließt „Karten verwalten“ nicht ein."""
    cfg(oidc_technician_groups="technik", oidc_manage_maps_groups="karten")
    expected = {"technik": (True, False), "karten": (False, True)}
    for group, (tech, maps) in expected.items():
        with TestClient(app) as c:
            oidc.callback(c, sub=uuid.uuid4().hex, preferred_username=_name(group), groups=[group])
            me = c.get("/auth/me").json()
            assert (me["is_technician"], me["can_manage_maps"]) == (tech, maps)
            assert me["is_technician_effective"] is tech and me["can_manage_maps_effective"] is maps
            status_code = c.post("/api/maps", json={"id": _name("m"), "name": "M", "url": "http://x.invalid/a.zip"}).status_code
            assert (status_code != 403) is maps


def test_auth_r_008_abgleich_bei_jedem_login_setzt_genau_nach_gruppen(admin, cfg, oidc):
    cfg(**RIGHTS)
    uid, sub, name = _oidc_user(oidc, groups=["members", "bauer", "zeuse", "chefs"])
    u = _db_user(uid)
    assert (u.role, u.is_mission_builder, u.is_zeus, u.can_create_plans) == ("admin", True, True, True)

    with TestClient(app) as c:
        oidc.callback(c, sub=sub, preferred_username=name, groups=["zeuse"])
        me = c.get("/auth/me").json()
    assert (me["role"], me["is_mission_builder"], me["is_zeus"], me["can_create_plans"]) == ("user", False, True, False)

    # AUTH-R-013: Änderung steht mit alt -> neu im Protokoll, ohne Token
    changes = _audit("oidc.rights_sync", uid)[-1].detail["changes"]
    assert changes == {"role": ["admin", "user"], "is_mission_builder": [True, False], "can_create_plans": [True, False]}


def test_auth_r_008_entzug_wirkt_sofort_in_laufenden_sitzungen(client, cfg, oidc):
    """Sitzungen tragen keine Rechte; sie werden je Anfrage aus der Datenbank gelesen. Ein
    neuer Login (auch in einem anderen Browser) wirkt deshalb sofort auf alle Sitzungen."""
    cfg(**RIGHTS)
    name, sub = _name("exadmin"), uuid.uuid4().hex
    oidc.callback(client, sub=sub, preferred_username=name, groups=["chefs"])
    assert client.get("/api/admin/users").status_code == 200
    with TestClient(app) as other:
        oidc.callback(other, sub=sub, preferred_username=name, groups=[])
    assert client.get("/api/admin/users").status_code == 403


def test_auth_r_008_nicht_angebundene_rechte_bleiben_unberuehrt(admin, cfg, oidc):
    cfg(oidc_mission_builder_groups="bauer")  # nur Missionsbau ist angebunden
    uid, sub, name = _oidc_user(oidc, groups=["bauer"])
    r = admin.patch(f"/api/admin/users/{uid}", json={"role": "admin", "is_zeus": True, "can_create_plans": True})
    assert r.status_code == 200
    with TestClient(app) as c:
        oidc.callback(c, sub=sub, preferred_username=name, groups=[])
    u = _db_user(uid)
    assert (u.role, u.is_zeus, u.can_create_plans) == ("admin", True, True)
    assert u.is_mission_builder is False


def test_auth_r_008_ohne_aenderung_kein_protokolleintrag(cfg, oidc):
    cfg(**RIGHTS)
    uid, sub, name = _oidc_user(oidc, groups=["members"])
    before = len(_audit("oidc.rights_sync", uid))
    with TestClient(app) as c:
        oidc.callback(c, sub=sub, preferred_username=name, groups=["members"])
    assert len(_audit("oidc.rights_sync", uid)) == before


def test_auth_r_008_verwaltung_sperrt_angebundene_rechte(admin, cfg, oidc):
    cfg(**RIGHTS)
    uid, _, _ = _oidc_user(oidc, groups=["members"])
    row = next(u for u in admin.get("/api/admin/users").json() if u["id"] == uid)
    assert row["has_oidc"] is True
    assert set(row["managed_fields"]) == {"role", "is_mission_builder", "is_zeus", "can_create_plans"}

    for body in ({"role": "admin"}, {"is_mission_builder": True}, {"is_zeus": True}, {"can_create_plans": False}):
        r = admin.patch(f"/api/admin/users/{uid}", json=body)
        assert r.status_code == 409, body
        assert "aus der Anmeldung" in r.json()["detail"]
    u = _db_user(uid)
    assert (u.role, u.is_mission_builder, u.is_zeus, u.can_create_plans) == ("user", False, False, True)

    # nicht angebundene Felder bleiben änderbar, auch zusammen mit unveränderten angebundenen
    r = admin.patch(f"/api/admin/users/{uid}", json={"display_name": "Neu", "is_active": True, "is_zeus": False})
    assert r.status_code == 200 and r.json()["display_name"] == "Neu"


def test_auth_r_008_verwaltung_sperrt_nur_angebundene(admin, cfg, oidc):
    cfg(oidc_zeus_groups="zeuse")
    uid, _, _ = _oidc_user(oidc)
    row = next(u for u in admin.get("/api/admin/users").json() if u["id"] == uid)
    assert row["managed_fields"] == ["is_zeus"]
    assert admin.patch(f"/api/admin/users/{uid}", json={"is_zeus": True}).status_code == 409
    assert admin.patch(f"/api/admin/users/{uid}", json={"is_mission_builder": True}).status_code == 200


def test_auth_r_008_lokale_konten_bleiben_von_hand_pflegbar(admin, cfg):
    cfg(**RIGHTS)
    uid, _, _ = _local_user(admin)
    row = next(u for u in admin.get("/api/admin/users").json() if u["id"] == uid)
    assert row["has_oidc"] is False and row["managed_fields"] == []
    r = admin.patch(f"/api/admin/users/{uid}", json={
        "role": "admin", "is_mission_builder": True, "is_zeus": True, "can_create_plans": True,
    })
    assert r.status_code == 200 and r.json()["role"] == "admin"


def test_auth_r_008_sitzungsdauer_ist_einstellbar(client, cfg):
    from app.security import issue_session, read_session

    cfg(session_ttl_hours=24)
    r = client.post("/auth/login", json={"username": "admin", "password": ADMIN_PW})
    assert "max-age=86400" in r.headers["set-cookie"].lower()

    cfg(session_ttl_hours=0, session_ttl_days=7)
    assert get_settings().session_ttl_seconds() == 7 * 86400  # Standard unverändert
    cfg(session_ttl_hours=1)
    assert get_settings().session_ttl_seconds() == 3600
    token = issue_session("abc", 0)
    assert read_session(token) == ("abc", 0)


def test_auth_r_008_abgelaufene_sitzung_gilt_nicht(cfg, monkeypatch):
    from app import security

    cfg(session_ttl_hours=1)
    token = security.issue_session("abc", 0)
    real = time.time
    monkeypatch.setattr(time, "time", lambda: real() + 3700)
    assert security.read_session(token) is None


def test_auth_r_008_sitzung_gleitet_bei_aktivitaet(client, cfg, monkeypatch):
    cfg(session_ttl_hours=8)
    client.post("/auth/login", json={"username": "admin", "password": ADMIN_PW})
    # Frisches Cookie: keine Erneuerung
    r = client.get("/auth/me")
    assert r.status_code == 200 and "set-cookie" not in r.headers
    # Nach > 1/4 der Laufzeit (2 h) wird das Cookie neu ausgestellt
    real = time.time
    monkeypatch.setattr(time, "time", lambda: real() + 3 * 3600)
    r = client.get("/auth/me")
    assert r.status_code == 200
    assert "sidc_session=" in r.headers["set-cookie"] and "max-age=28800" in r.headers["set-cookie"].lower()


def test_auth_r_010_start_admin_bleibt_admin(admin, cfg, oidc):
    from app import oidc_access

    cfg(**RIGHTS)
    with SessionLocal() as db:
        boot = db.scalar(select(User).where(User.username == "admin"))
        other = User(username=_name("kein-admin"), role="admin")
        assert oidc_access.sync_rights(boot, set()) .get("role") is None and boot.role == "admin"
        assert oidc_access.sync_rights(other, set())["role"] == ["admin", "user"]
        db.rollback()


# ─── AUTH-R-011: state und nonce ───────────────────────────────────────────

ISSUER = "https://idp.example.test/application/o/c2/"


@pytest.fixture
def real_authlib(monkeypatch):
    """Echter authlib-Client mit festen Metadaten und eigenem Schlüssel; nur der Abruf des
    Tokens beim Provider ist ersetzt. So laufen die Prüfungen von ``state``, Signatur und
    ``nonce`` wirklich."""
    from authlib.integrations.starlette_client import OAuth
    from authlib.jose import JsonWebKey, jwt

    from app.routers import auth

    key = JsonWebKey.generate_key("RSA", 2048, is_private=True, options={"kid": "test"})
    oauth = OAuth()
    oauth.register(
        name="oidc", client_id="c2", client_secret="not-a-secret", issuer=ISSUER,
        authorize_url=ISSUER + "authorize", access_token_url=ISSUER + "token",
        jwks={"keys": [key.as_dict(is_private=False)]},
        client_kwargs={"scope": "openid profile"},
    )
    state = {"nonce": None, "sub": uuid.uuid4().hex}

    async def fake_fetch(**kwargs):
        ts = int(time.time())
        payload = {"iss": ISSUER, "aud": "c2", "sub": state["sub"], "iat": ts, "exp": ts + 300,
                   "nonce": state["nonce"], "preferred_username": "r011-" + state["sub"][:8]}
        token = jwt.encode({"alg": "RS256", "kid": "test"}, payload, key).decode()
        return {"access_token": "fake", "token_type": "Bearer", "id_token": token}

    monkeypatch.setattr(oauth.oidc, "fetch_access_token", fake_fetch)
    monkeypatch.setattr(auth, "_OIDC_READY", True)
    monkeypatch.setattr(auth, "_oauth", oauth)
    return state


def _start(c) -> dict:
    r = c.get("/auth/oidc/login", follow_redirects=False)
    assert r.status_code == 302
    return {k: v[0] for k, v in parse_qs(urlparse(r.headers["location"]).query).items()}


def test_auth_r_011_state_und_nonce_werden_gesetzt_und_geprueft(real_authlib):
    with TestClient(app, base_url="https://testserver") as c:
        q = _start(c)
        assert q["response_type"] == "code" and q["state"] and q["nonce"]
        assert q["scope"] == "openid profile"
        assert "client_secret" not in q

        # falscher state: kein Login
        r = c.get("/auth/oidc/callback?code=x&state=gefaelscht", follow_redirects=False)
        assert r.status_code == 303 and r.headers["location"] == "/?auth=failed"
        assert c.get("/auth/me").status_code == 401

        # richtiger state, aber falsches nonce im ID-Token: kein Login
        q = _start(c)
        real_authlib["nonce"] = "falsches-nonce"
        r = c.get(f"/auth/oidc/callback?code=x&state={q['state']}", follow_redirects=False)
        assert r.headers["location"] == "/?auth=failed"
        assert c.get("/auth/me").status_code == 401

        # state lässt sich nicht ein zweites Mal verwenden
        real_authlib["nonce"] = q["nonce"]
        r = c.get(f"/auth/oidc/callback?code=x&state={q['state']}", follow_redirects=False)
        assert r.headers["location"] == "/?auth=failed"

        # beides richtig: Login
        q = _start(c)
        real_authlib["nonce"] = q["nonce"]
        r = c.get(f"/auth/oidc/callback?code=x&state={q['state']}", follow_redirects=False)
        assert r.status_code == 303 and r.headers["location"] == "/"
        assert c.get("/auth/me").json()["username"].startswith("r011-")


def test_auth_r_011_rueckruf_ohne_begonnenen_ablauf(real_authlib):
    with TestClient(app, base_url="https://testserver") as c:
        r = c.get("/auth/oidc/callback?code=x&state=irgendwas", follow_redirects=False)
        assert r.headers["location"] == "/?auth=failed"
        r = c.get("/auth/oidc/callback?error=access_denied", follow_redirects=False)
        assert r.headers["location"] == "/?auth=failed"


# ─── AUTH-R-012: Abmelden ──────────────────────────────────────────────────

def test_auth_r_012_abmelden_beendet_nur_die_sitzung_im_tool(oidc):
    """Kein Aufruf beim Provider, keine Weiterleitung dorthin; andere Sitzungen bleiben."""
    name, sub = _name("abmelden"), uuid.uuid4().hex
    with TestClient(app) as a, TestClient(app) as b:
        oidc.callback(a, sub=sub, preferred_username=name)
        oidc.callback(b, sub=sub, preferred_username=name)
        r = a.post("/auth/logout", follow_redirects=False)
        assert r.status_code == 200 and r.json() == {"ok": True} and "location" not in r.headers
        assert a.get("/auth/me").status_code == 401
        assert b.get("/auth/me").status_code == 200
