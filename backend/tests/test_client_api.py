"""API-Tokens + Token-Zugriff auf die Karten-Routen (lokaler ATAKmaps-Client)."""

from fastapi.testclient import TestClient

from app.main import app


def _make_map(admin, map_id="arland"):
    """Karte mit winzigem sat.mbtiles (ein Kachel z1/x0/y0) + Zusatzdateien im Kartenordner."""
    import sqlite3

    from app.db import SessionLocal
    from app.models import Map, now
    from app.services.maps_import import map_dir

    admin.post("/api/maps", json={"id": map_id, "name": "Arland", "url": "http://x.invalid/a.zip"})
    with SessionLocal() as db:
        m = db.get(Map, map_id)
        m.status = "ready"
        m.imported_at = now()
        db.commit()
    d = map_dir(map_id)
    (d / "mbtiles").mkdir(parents=True, exist_ok=True)
    path = d / "mbtiles" / "sat.mbtiles"
    if path.exists():  # der Tile-Router hält die Datei offen (Windows) - Testdaten sind geteilt
        return
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE metadata (name TEXT, value TEXT)")
    con.execute("CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)")
    con.executemany("INSERT INTO metadata VALUES (?, ?)",
                    [("bounds", "0,0,1,1"), ("minzoom", "1"), ("maxzoom", "1")])
    con.execute("INSERT INTO tiles VALUES (1, 0, 1, ?)", (b"PNG-tile",))  # TMS-Zeile 1 == XYZ y=0
    con.commit()
    con.close()
    (d / "contours.geojson").write_text('{"type": "FeatureCollection", "features": []}')


def _bearer(token: str) -> TestClient:
    """Frischer Client OHNE Cookie, nur mit Bearer-Header."""
    c = TestClient(app)
    c.headers["Authorization"] = f"Bearer {token}"
    return c


def _new_token(admin, name="Laptop", **kw) -> dict:
    r = admin.post("/api/tokens", json={"name": name, **kw})
    assert r.status_code == 201, r.text
    return r.json()


def test_token_lifecycle(admin):
    t = _new_token(admin)
    assert t["token"].startswith("sidc_") and t["scopes"] == ["maps:read"]

    listing = admin.get("/api/tokens").json()
    assert [x["id"] for x in listing] == [t["id"]]
    assert "token" not in listing[0]  # Klartext nie wieder sichtbar

    c = _bearer(t["token"])
    assert c.get("/api/client/ping").status_code == 200

    assert admin.delete(f"/api/tokens/{t['id']}").json()["ok"] is True
    assert c.get("/api/client/ping").status_code == 401
    assert admin.get("/api/tokens").json()[0]["revoked"] is True


def test_token_only_works_on_client_api(admin):
    """Der Token darf keine Pläne, Nutzer oder Tokens erreichen (Cookie-only-Routen)."""
    c = _bearer(_new_token(admin)["token"])
    assert c.get("/plans").status_code == 401
    assert c.get("/auth/me").status_code == 401
    assert c.get("/api/admin/users").status_code == 401
    assert c.post("/api/tokens", json={"name": "x"}).status_code == 401


def test_invalid_and_expired_tokens(admin):
    assert _bearer("sidc_nonsense").get("/api/client/ping").status_code == 401
    assert _bearer("not-a-token").get("/api/client/ping").status_code == 401

    t = _new_token(admin, expires_days=1)
    from datetime import timedelta

    from app.db import SessionLocal
    from app.models import ApiToken, now

    with SessionLocal() as db:
        row = db.get(ApiToken, t["id"])
        row.expires_at = now() - timedelta(minutes=1)
        db.commit()
    assert _bearer(t["token"]).get("/api/client/ping").status_code == 401


def test_deactivated_user_token_rejected(admin):
    r = admin.post("/api/admin/users", json={"username": "tester1", "password": "tester1-pass-xx"})
    uid = r.json()["id"]
    user = TestClient(app)
    user.post("/auth/login", json={"username": "tester1", "password": "tester1-pass-xx"})
    tok = user.post("/api/tokens", json={"name": "t"}).json()["token"]
    assert _bearer(tok).get("/api/client/ping").status_code == 200

    admin.patch(f"/api/admin/users/{uid}", json={"is_active": False})
    assert _bearer(tok).get("/api/client/ping").status_code == 401


def test_tokens_are_per_user(admin):
    admin.post("/api/admin/users", json={"username": "tester2", "password": "tester2-pass-xx"})
    other = TestClient(app)
    other.post("/auth/login", json={"username": "tester2", "password": "tester2-pass-xx"})
    mine = _new_token(admin)
    assert other.get("/api/tokens").json() == []
    assert other.delete(f"/api/tokens/{mine['id']}").status_code == 404


def test_token_reads_map_routes(admin):
    _make_map(admin)
    c = _bearer(_new_token(admin)["token"])

    maps = c.get("/api/maps").json()
    m = next(x for x in maps if x["id"] == "arland")
    assert m["imported_at"]  # Cache-Version für den Client

    r = c.get("/api/maps/arland/tiles/sat/1/0/0.png")
    assert r.status_code == 200 and r.content == b"PNG-tile"
    assert c.get("/api/maps/arland/tiles/sat/1/0/1.png").status_code == 404
    assert c.get("/api/maps/arland/contours.geojson").json()["type"] == "FeatureCollection"
    assert c.get("/api/maps/arland/topo.geojson").status_code == 404  # existiert nicht

    style = c.get("/api/maps/arland/style.json").json()
    assert style["sources"]["sat"]["tiles"] == ["/api/maps/arland/tiles/sat/{z}/{x}/{y}.png"]


def test_map_routes_still_need_auth(admin):
    _make_map(admin)
    anon = TestClient(app)
    for path in ("/api/maps", "/api/maps/arland/tiles/sat/1/0/0.png", "/api/maps/arland/style.json"):
        assert anon.get(path).status_code == 401
    assert _bearer("sidc_nonsense").get("/api/maps/arland/tiles/sat/1/0/0.png").status_code == 401


def test_revoked_token_loses_map_access(admin):
    _make_map(admin)
    t = _new_token(admin)
    c = _bearer(t["token"])
    assert c.get("/api/maps/arland/tiles/sat/1/0/0.png").status_code == 200
    admin.delete(f"/api/tokens/{t['id']}")
    assert c.get("/api/maps/arland/tiles/sat/1/0/0.png").status_code == 401


def test_token_cannot_change_maps_or_reach_plans(admin):
    _make_map(admin)
    c = _bearer(_new_token(admin)["token"])
    assert c.delete("/api/maps/arland").status_code == 401
    assert c.post("/api/maps", json={"id": "xx", "name": "x", "url": "http://x.invalid/a.zip"}).status_code == 401
    assert c.post("/api/maps/arland/reimport").status_code == 401
    assert c.get("/plans").status_code == 401
    assert c.get("/api/admin/users").status_code == 401


def test_ping_reports_protocol_and_user(admin):
    c = _bearer(_new_token(admin, name="Sky Laptop")["token"])
    data = c.get("/api/client/ping").json()
    assert data["protocol"] == 2 and data["token"]["name"] == "Sky Laptop"
    assert data["token"]["scopes"] == ["maps:read"] and data["user"]["label"]
