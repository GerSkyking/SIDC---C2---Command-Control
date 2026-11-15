"""Spec „Anmeldung und Zugriff“: Verknüpfen bestehender Konten (AUTH-R-014), Start-Admin
(AUTH-R-010) und die Härtungen aus dem Review vom 2026-11-13."""

import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app import oidc_access
from app.config import Settings, get_settings
from app.db import SessionLocal
from app.main import app
from app.models import ApiToken, AuditLog, OidcIdentity, OidcLinkCode, User, now

ADMIN_PW = "test-admin-pass-123"
PW = "local-user-pass-123"


def _name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _db_user(user_id: str) -> User:
    with SessionLocal() as db:
        return db.get(User, user_id)


def _audit(action: str) -> list[AuditLog]:
    with SessionLocal() as db:
        return list(db.scalars(select(AuditLog).where(AuditLog.action == action)))


def _local_user(admin, **extra) -> tuple[str, str]:
    name = _name("local")
    r = admin.post("/api/admin/users", json={"username": name, "password": PW, **extra})
    assert r.status_code == 201
    return r.json()["id"], name


def _oidc_user(oidc, **claims) -> tuple[str, str, str]:
    sub = claims.pop("sub", None) or uuid.uuid4().hex
    name = claims.pop("preferred_username", None) or _name("oidc")
    with TestClient(app) as c:
        r = oidc.callback(c, sub=sub, preferred_username=name, **claims)
        assert r.status_code == 303 and r.headers["location"] == "/", r.text
        return c.get("/auth/me").json()["id"], sub, name


def _link(admin, uid: str) -> str:
    r = admin.post(f"/api/admin/users/{uid}/oidc-link")
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["path"] == f"/#/link/{body['code']}"
    return body["code"]


def _redeem(oidc, code: str, login_as: str | None, **claims):
    """Link einlösen wie im Browser: (optional) lokal anmelden, Link öffnen, Rückruf vom
    Provider. Gibt (Antwort des Rückrufs, /auth/me danach oder None, Auskunft der Link-Seite)."""
    with TestClient(app, base_url="https://testserver") as c:
        if login_as:
            assert c.post("/auth/login", json={"username": login_as, "password": PW}).status_code == 200
        info = c.post("/auth/oidc/link", json={"code": code}).json()
        r = oidc.callback(c, **claims)
        me = c.get("/auth/me")
        return r, (me.json() if me.status_code == 200 else None), info


# ─── AUTH-R-014: Verknüpfen ────────────────────────────────────────────────

def test_auth_r_014_besitzer_verknuepft_eigenes_konto(admin, cfg, oidc):
    cfg(oidc_mission_builder_groups="bauer", oidc_sync_display_name=True)
    uid, name = _local_user(admin, can_create_plans=True, is_mission_builder=True)
    code = _link(admin, uid)
    assert code not in str([a.detail for a in _audit("oidc.link_code")])  # Code nie im Protokoll
    with SessionLocal() as db:
        assert db.scalar(select(OidcLinkCode).where(OidcLinkCode.code_hash == code)) is None  # nur der Hash

    sub = uuid.uuid4().hex
    r, me, info = _redeem(oidc, code, name, sub=sub, preferred_username=_name("anders"), name="Aus Portal", groups=[])
    assert info == {"ok": True, "valid": True, "account": name, "owner_session": True}
    assert r.status_code == 303 and r.headers["location"] == "/"
    # kein zweites Konto: dieselbe ID, derselbe Login-Name; danach gelten die Regeln für OIDC-Konten
    assert me["id"] == uid and me["username"] == name
    assert me["display_name"] == "Aus Portal"
    assert me["is_mission_builder"] is False  # angebunden: nach Gruppen gesetzt
    assert me["can_create_plans"] is True  # nicht angebunden: bleibt
    assert any(a.user_id == uid for a in _audit("oidc.link"))

    # danach Wiedererkennen über Aussteller + sub (AUTH-R-004), ohne Code
    with TestClient(app) as c:
        oidc.callback(c, sub=sub, preferred_username=_name("egal"))
        assert c.get("/auth/me").json()["id"] == uid

    # für ein verknüpftes Konto gibt es keinen neuen Code
    assert admin.post(f"/api/admin/users/{uid}/oidc-link").status_code == 409


def test_auth_r_014_nach_dem_verknuepfen_sind_alte_sitzung_passwort_und_tokens_ungueltig(admin, oidc):
    uid, name = _local_user(admin)
    with TestClient(app) as old:
        assert old.post("/auth/login", json={"username": name, "password": PW}).status_code == 200
        raw = old.post("/api/tokens", json={"name": "alt"}).json()["token"]
        bearer = {"Authorization": f"Bearer {raw}"}
        with TestClient(app) as api:
            assert api.get("/api/client/ping", headers=bearer).status_code == 200

        r, me, _ = _redeem(oidc, _link(admin, uid), name, sub=uuid.uuid4().hex, preferred_username=_name("p"))
        assert r.headers["location"] == "/" and me["id"] == uid

        assert old.get("/auth/me").status_code == 401  # alte Sitzung
        with TestClient(app) as api:
            assert api.get("/api/client/ping", headers=bearer).status_code == 401  # API-Token
    u = _db_user(uid)
    assert u.password_hash is None
    with TestClient(app) as c:  # lokales Passwort
        r = c.post("/auth/login", json={"username": name, "password": PW})
        assert r.status_code == 401 and r.json()["detail"] == "Login fehlgeschlagen"
    with SessionLocal() as db:
        assert db.scalar(select(ApiToken).where(ApiToken.user_id == uid, ApiToken.revoked_at.is_(None))) is None
    row = next(x for x in admin.get("/api/admin/users").json() if x["id"] == uid)
    assert row["is_local"] is False and row["has_oidc"] is True


def test_auth_r_014_fremde_person_kann_den_code_nicht_einloesen(admin, cfg, oidc):
    """Review H1: Der Besitzer gibt seinen Link an jemanden mit Admin-Gruppe weiter. Ohne
    lokale Sitzung des Zielkontos wird nichts verknüpft, und das Konto erbt keine Rechte."""
    cfg(oidc_admin_groups="leitung", oidc_required_groups="members")
    uid, name = _local_user(admin)
    code = _link(admin, uid)
    sub, victim_name = uuid.uuid4().hex, _name("leiter")

    with TestClient(app) as owner:
        assert owner.post("/auth/login", json={"username": name, "password": PW}).status_code == 200

        r, me, info = _redeem(oidc, code, None, sub=sub, preferred_username=victim_name, groups=["members", "leitung"])
        assert info == {"ok": True, "valid": True, "account": name, "owner_session": False}
        assert r.status_code == 303 and r.headers["location"] == "/?auth=link-login-first"
        assert me is None  # keine Sitzung, auch kein neu angelegtes Konto
        with SessionLocal() as db:
            assert db.scalar(select(OidcIdentity).where(OidcIdentity.subject == sub)) is None
            assert db.scalar(select(User).where(User.username == victim_name)) is None
        assert _audit("oidc.link_fail")[-1].detail["reason"] == "not_owner"

        # der Besitzer ist unverändert: Sitzung gilt, Rolle user, Passwort da
        assert owner.get("/auth/me").json()["role"] == "user"
    assert _db_user(uid).password_hash is not None

    # der Code ist nicht verbraucht: der Besitzer selbst kann ihn danach einlösen
    r, me, _ = _redeem(oidc, code, name, sub=uuid.uuid4().hex, preferred_username=_name("selbst"), groups=["members"])
    assert r.headers["location"] == "/" and me["id"] == uid and me["role"] == "user"


def test_auth_r_014_sitzung_eines_anderen_kontos_reicht_nicht(admin, oidc):
    uid, _ = _local_user(admin)
    _, other_name = _local_user(admin)
    r, me, info = _redeem(oidc, _link(admin, uid), other_name, sub=uuid.uuid4().hex, preferred_username=_name("x"))
    assert info["owner_session"] is False
    assert r.headers["location"] == "/?auth=link-login-first"
    assert me["username"] == other_name  # bleibt als das eigene Konto angemeldet
    assert not oidc_access.has_identity(SessionLocal(), uid)


def test_auth_r_014_ungueltiger_code_legt_kein_konto_an(admin, oidc):
    name, sub = _name("falschercode"), uuid.uuid4().hex
    r, me, info = _redeem(oidc, "gibt-es-nicht", None, sub=sub, preferred_username=name)
    assert info == {"ok": True, "valid": False, "account": None, "owner_session": False}
    assert r.headers["location"] == "/?auth=link-failed" and me is None
    with SessionLocal() as db:
        assert db.scalar(select(User).where(User.username == name)) is None
        assert db.scalar(select(OidcIdentity).where(OidcIdentity.subject == sub)) is None
    assert _audit("oidc.link_fail")[-1].detail["reason"] == "invalid_code"


def test_auth_r_014_abgelaufener_code(admin, oidc):
    uid, name = _local_user(admin)
    code = _link(admin, uid)
    with SessionLocal() as db:
        row = db.scalar(select(OidcLinkCode).where(OidcLinkCode.user_id == uid))
        row.expires_at = now() - timedelta(minutes=1)
        db.commit()
    r, me, info = _redeem(oidc, code, name, sub=uuid.uuid4().hex, preferred_username=_name("spaet"))
    assert info["valid"] is False
    assert r.headers["location"] == "/?auth=link-failed"
    assert not oidc_access.has_identity(SessionLocal(), uid)


def test_auth_r_014_neuer_code_ersetzt_den_alten(admin, oidc):
    uid, name = _local_user(admin)
    old = _link(admin, uid)
    new = _link(admin, uid)
    r, _, _ = _redeem(oidc, old, name, sub=uuid.uuid4().hex, preferred_username=_name("alt"))
    assert r.headers["location"] == "/?auth=link-failed"
    r, me, _ = _redeem(oidc, new, name, sub=uuid.uuid4().hex, preferred_username=_name("neu"))
    assert r.headers["location"] == "/" and me["id"] == uid


def test_auth_r_014_code_gilt_genau_einmal(admin, oidc):
    """Review N2: Das Einlösen ist ein einzelnes UPDATE mit Bedingung; ein zweites greift nicht."""
    uid, name = _local_user(admin)
    code = _link(admin, uid)
    with SessionLocal() as a, SessionLocal() as b:
        row_a = oidc_access.find_link_code(a, code)
        row_b = oidc_access.find_link_code(b, code)  # beide Anfragen sehen den Code noch als gültig
        assert oidc_access.consume_link_code(a, row_a) is True
        a.commit()
        assert oidc_access.consume_link_code(b, row_b) is False
        b.rollback()
    with SessionLocal() as db:
        assert oidc_access.find_link_code(db, code) is None

    uid2, name2 = _local_user(admin)
    code2 = _link(admin, uid2)
    sub = uuid.uuid4().hex
    r, me, _ = _redeem(oidc, code2, name2, sub=sub, preferred_username=_name("erst"))
    assert r.headers["location"] == "/" and me["id"] == uid2
    # zweites Einlösen desselben Codes (andere Person, kein Konto mehr mit Passwort): scheitert
    r, me, info = _redeem(oidc, code2, None, sub=uuid.uuid4().hex, preferred_username=_name("zweit"))
    assert info["valid"] is False and r.headers["location"] == "/?auth=link-failed" and me is None
    with SessionLocal() as db:
        assert list(db.scalars(select(OidcIdentity.subject).where(OidcIdentity.user_id == uid2))) == [sub]


def test_auth_r_014_identitaet_haengt_schon_an_anderem_konto(admin, oidc):
    other_id, sub, other_name = _oidc_user(oidc)
    uid, name = _local_user(admin)
    r, me, _ = _redeem(oidc, _link(admin, uid), name, sub=sub, preferred_username=other_name)
    assert r.headers["location"] == "/?auth=link-failed"
    assert me["id"] == uid  # die lokale Sitzung bleibt, wie sie war
    assert _audit("oidc.link_fail")[-1].detail["reason"] == "identity_in_use"
    with SessionLocal() as db:
        assert db.scalar(select(OidcIdentity.user_id).where(OidcIdentity.subject == sub)) == other_id
    assert _db_user(uid).password_hash is not None


def test_auth_r_014_ohne_zugangsgruppe_wird_nicht_verknuepft(admin, cfg, oidc):
    cfg(oidc_required_groups="members")
    uid, name = _local_user(admin)
    code = _link(admin, uid)
    sub = uuid.uuid4().hex
    r, _, _ = _redeem(oidc, code, name, sub=sub, preferred_username=_name("fremd"), groups=[])
    assert r.headers["location"] == "/?auth=denied"
    with SessionLocal() as db:
        assert db.scalar(select(OidcIdentity).where(OidcIdentity.subject == sub)) is None
    u = _db_user(uid)
    assert u.is_active is True and u.password_hash is not None
    # der Code ist nicht verbraucht: mit Gruppe klappt es
    r, me, _ = _redeem(oidc, code, name, sub=sub, preferred_username=_name("fremd"), groups=["members"])
    assert r.headers["location"] == "/" and me["id"] == uid


def test_auth_r_014_nur_admins_und_nur_mit_oidc(admin, oidc, monkeypatch):
    from app.routers import auth

    uid, name = _local_user(admin)
    with TestClient(app) as c:
        c.post("/auth/login", json={"username": name, "password": PW})
        assert c.post(f"/api/admin/users/{uid}/oidc-link").status_code == 403
    assert admin.post("/api/admin/users/gibtesnicht/oidc-link").status_code == 404
    monkeypatch.setattr(auth, "_OIDC_READY", False)
    assert admin.post(f"/api/admin/users/{uid}/oidc-link").status_code == 400
    assert admin.post("/auth/oidc/link", json={"code": "x"}).status_code == 404


def test_auth_r_014_start_admin_ist_nicht_verknuepfbar(admin, oidc):
    """Review M2: Der Start-Admin bleibt der lokale Notfallzugang."""
    me = admin.get("/auth/me").json()
    row = next(x for x in admin.get("/api/admin/users").json() if x["id"] == me["id"])
    assert row["is_bootstrap"] is True
    r = admin.post(f"/api/admin/users/{me['id']}/oidc-link")
    assert r.status_code == 409 and "Start-Admin" in r.json()["detail"]

    # selbst ein (hier von Hand angelegter) Code für den Start-Admin lässt sich nicht einlösen
    with SessionLocal() as db:
        code, _ = oidc_access.create_link_code(db, db.get(User, me["id"]), None)
    sub = uuid.uuid4().hex
    with TestClient(app, base_url="https://testserver") as c:
        c.post("/auth/login", json={"username": "admin", "password": ADMIN_PW})
        assert c.post("/auth/oidc/link", json={"code": code}).json()["valid"] is False
        assert oidc.callback(c, sub=sub, preferred_username=_name("x")).headers["location"] == "/?auth=link-failed"
    with SessionLocal() as db:
        assert db.scalar(select(OidcIdentity).where(OidcIdentity.subject == sub)) is None
        db.query(OidcLinkCode).filter(OidcLinkCode.user_id == me["id"]).delete()
        db.commit()
    assert _db_user(me["id"]).password_hash is not None


# ─── AUTH-R-010: Start-Admin ist ein festes Merkmal, kein Name (Review H2) ─

def test_auth_r_010_start_admin_ist_markiert(admin):
    me = admin.get("/auth/me").json()
    u = _db_user(me["id"])
    assert u.is_bootstrap is True and oidc_access.is_bootstrap_admin(u)
    with SessionLocal() as db:
        assert list(db.scalars(select(User.username).where(User.is_bootstrap.is_(True)))) == ["admin"]


def test_auth_r_010_namensgleiches_oidc_konto_wird_nicht_admin(client, cfg, oidc):
    """Kein lokales Konto dieses Namens vorhanden; ein OIDC-Konto bekommt den Namen nicht."""
    boot = _name("chef")
    cfg(bootstrap_admin_user=boot, oidc_admin_groups="leitung", oidc_required_groups="members")
    sub = uuid.uuid4().hex
    r = oidc.callback(client, sub=sub, preferred_username=boot + "@evil.example", groups=["members"])
    assert r.headers["location"] == "/"
    me = client.get("/auth/me").json()
    assert me["role"] == "user" and me["username"] == f"{boot}-2"
    assert _db_user(me["id"]).is_bootstrap is False

    # und es wird deaktiviert wie jedes andere Konto, wenn die Zugangsgruppe fehlt (AUTH-R-009)
    r = oidc.callback(client, sub=sub, preferred_username=boot, groups=[])
    assert r.headers["location"] == "/?auth=denied"
    assert _db_user(me["id"]).is_active is False


def test_auth_r_010_name_des_start_admins_wird_nie_vergeben(client, cfg, oidc):
    boot = _name("Chef")
    cfg(bootstrap_admin_user=boot, oidc_admin_groups="leitung")
    for claims in ({"preferred_username": boot.upper()}, {"email": boot.lower() + "@x.example"}):
        with _Same(client) as c:
            oidc.callback(c, sub=uuid.uuid4().hex, groups=[], **claims)
            me = c.get("/auth/me").json()
            assert me["username"].lower() != boot.lower() and me["username"].lower().startswith(boot.lower() + "-")
            assert me["role"] == "user"


class _Same:
    """Denselben Client weiterverwenden (kein neuer App-Start, solange BOOTSTRAP_ADMIN_USER
    für den Test verstellt ist: Der Start würde sonst ein Konto dieses Namens anlegen)."""

    def __init__(self, client):
        self.client = client

    def __enter__(self):
        self.client.cookies.clear()
        return self.client

    def __exit__(self, *exc):
        return False


def test_auth_r_010_start_hebt_kein_oidc_konto_zum_admin(client, cfg, oidc, monkeypatch):
    """``ensure_bootstrap_admin`` hob bisher jedes Konto dieses Namens auf Admin."""
    from app.bootstrap import ensure_bootstrap_admin

    uid, _, name = _oidc_user(oidc)
    s = get_settings()
    try:
        monkeypatch.setattr(s, "bootstrap_admin_user", name)
        ensure_bootstrap_admin()
        u = _db_user(uid)
        assert u.role == "user" and u.is_bootstrap is False and u.password_hash is None
        with SessionLocal() as db:
            assert len(list(db.scalars(select(User).where(User.username == name)))) == 1
    finally:
        monkeypatch.setattr(s, "bootstrap_admin_user", "admin")
        ensure_bootstrap_admin()
    with SessionLocal() as db:
        assert list(db.scalars(select(User.username).where(User.is_bootstrap.is_(True)))) == ["admin"]


def test_auth_r_010_start_markiert_bestehendes_lokales_konto(admin, monkeypatch):
    """Bestand: Das lokale Konto mit dem Namen aus BOOTSTRAP_ADMIN_USER wird beim Start markiert."""
    from app.bootstrap import ensure_bootstrap_admin

    with SessionLocal() as db:
        u = db.scalar(select(User).where(User.username == "admin"))
        u.is_bootstrap = False
        db.commit()
    ensure_bootstrap_admin()
    with SessionLocal() as db:
        assert db.scalar(select(User).where(User.username == "admin")).is_bootstrap is True


def test_auth_r_002_notfallzugang_haengt_am_merkmal_nicht_am_namen(admin, cfg):
    uid, name = _local_user(admin)
    cfg(local_login="bootstrap-admin", bootstrap_admin_user=name)  # Name passt, Merkmal fehlt
    with _Same(admin) as c:
        assert c.post("/auth/login", json={"username": name, "password": PW}).status_code == 401
        assert c.post("/auth/login", json={"username": "admin", "password": ADMIN_PW}).status_code == 200


# ─── Review M1: verknüpfte Konten melden sich nicht lokal an ───────────────

def test_auth_r_008_lokaler_login_fuer_oidc_konto_abgelehnt(admin, cfg, oidc, monkeypatch):
    """Sonst gingen Zugangsprüfung und Abgleich am lokalen Passwort vorbei (Altbestand:
    ein OIDC-Konto, dem ein Admin ein Passwort gesetzt hat)."""
    from app.routers import auth

    cfg(oidc_required_groups="members", oidc_admin_groups="leitung")
    uid, sub, name = _oidc_user(oidc, groups=["members", "leitung"])
    assert admin.patch(f"/api/admin/users/{uid}", json={"password": PW}).status_code == 200

    calls = []
    real = auth.verify_password
    monkeypatch.setattr(auth, "verify_password", lambda p, h: calls.append(1) or real(p, h))
    with TestClient(app) as c:
        r = c.post("/auth/login", json={"username": name, "password": PW})
        assert r.status_code == 401 and r.json()["detail"] == "Login fehlgeschlagen"
        assert c.get("/auth/me").status_code == 401
    assert len(calls) == 1  # Argon2 läuft trotzdem


def test_auth_r_010_start_admin_meldet_sich_lokal_an_auch_mit_identitaet(admin, oidc):
    me = admin.get("/auth/me").json()
    sub = uuid.uuid4().hex
    with SessionLocal() as db:
        db.add(OidcIdentity(user_id=me["id"], issuer=oidc.issuer, subject=sub))
        db.commit()
    try:
        with TestClient(app) as c:
            assert c.post("/auth/login", json={"username": "admin", "password": ADMIN_PW}).status_code == 200
        assert _db_user(me["id"]).is_bootstrap is True  # der Start nimmt das Merkmal nicht weg
    finally:
        with SessionLocal() as db:
            db.query(OidcIdentity).filter(OidcIdentity.subject == sub).delete()
            db.commit()


# ─── Review N1: Markierung „vom Abgleich deaktiviert“ ──────────────────────

def test_auth_r_009_unveraendertes_is_active_laesst_markierung_stehen(admin, cfg, oidc):
    cfg(oidc_required_groups="members")
    uid, sub, name = _oidc_user(oidc, groups=["members"])
    with TestClient(app) as c:
        oidc.callback(c, sub=sub, preferred_username=name, groups=[])
    assert _db_user(uid).deactivated_by_sync is True

    # die Oberfläche schickt is_active mit, ohne es zu ändern: keine Entscheidung des Admins
    assert admin.patch(f"/api/admin/users/{uid}", json={"display_name": "x", "is_active": False}).status_code == 200
    assert _db_user(uid).deactivated_by_sync is True
    with TestClient(app) as c:
        assert oidc.callback(c, sub=sub, preferred_username=name, groups=["members"]).headers["location"] == "/"
    assert _db_user(uid).is_active is True


# ─── Review N3: Listen ohne Gruppe ─────────────────────────────────────────

@pytest.mark.parametrize("field", [
    "oidc_required_groups", "oidc_admin_groups", "oidc_mission_builder_groups", "oidc_zeus_groups",
    "oidc_create_plans_groups",
])
@pytest.mark.parametrize("value", [",", " ", " , ,"])
def test_auth_r_003_gesetzte_liste_ohne_gruppe_bricht_den_start_ab(field, value, monkeypatch):
    """Sonst hieße ein Tippfehler still „keine Zugangsprüfung“ bzw. „Recht nicht angebunden“."""
    monkeypatch.setenv(field.upper(), value)
    with pytest.raises(ValueError) as exc:
        Settings(_env_file=None)
    assert field.upper() in str(exc.value) and "keine Gruppe" in str(exc.value)


def test_auth_r_003_leere_liste_bleibt_erlaubt(monkeypatch):
    monkeypatch.setenv("OIDC_REQUIRED_GROUPS", "")
    monkeypatch.setenv("OIDC_ADMIN_GROUPS", "a, ,b")
    s = Settings(_env_file=None)
    assert oidc_access.required_groups(s) == set()
    assert oidc_access.right_groups(s) == {"role": {"a", "b"}}


# ─── Form des Gruppen-Claims ───────────────────────────────────────────────

@pytest.mark.parametrize("raw, expected", [
    (["members", "leitung"], {"members", "leitung"}),
    ("members", {"members"}),  # einzelner Text = eine Gruppe
    ("members,leitung", {"members,leitung"}),  # wird nicht zerlegt: kein Treffer auf Teilnamen
    ([["members"]], set()),  # verschachtelt
    ([{"name": "members"}, 5, None, "", "leitung"], {"leitung"}),
    ({"members": True}, set()),
    (None, set()),
    (5, set()),
    ("", set()),
    (["Members", "members "], {"Members", "members "}),  # exakter Vergleich, kein Angleichen
])
def test_auth_r_003_formen_des_gruppen_claims(raw, expected):
    assert oidc_access.token_groups({"groups": raw}) == expected


def test_auth_r_003_gruppen_claim_als_text_verschachtelt_oder_leer(client, cfg, oidc):
    cfg(oidc_required_groups="members", oidc_admin_groups="leitung")
    for raw in ([["members"]], None, {"members": 1}, "members,leitung", ["Members"], ["members "]):
        r = oidc.callback(client, sub=uuid.uuid4().hex, preferred_username=_name("form"), groups=raw)
        assert r.headers["location"] == "/?auth=denied", raw
    r = oidc.callback(client, sub=uuid.uuid4().hex, preferred_username=_name("text"), groups="members")
    assert r.headers["location"] == "/"
    assert client.get("/auth/me").json()["role"] == "user"


# ─── Review N6: sub ist kein Text ──────────────────────────────────────────

@pytest.mark.parametrize("sub", [12345678901, ["a"], {"x": 1}, True])
def test_auth_r_004_sub_das_kein_text_ist_wird_sauber_abgelehnt(client, oidc, sub):
    before = len(_audit("oidc.fail"))
    r = oidc.callback(client, sub=sub, preferred_username=_name("zahl"))
    assert r.status_code == 303 and r.headers["location"] == "/?auth=failed"
    assert client.get("/auth/me").status_code == 401
    entries = _audit("oidc.fail")
    assert len(entries) == before + 1 and entries[-1].detail["reason"] == "invalid_sub"
