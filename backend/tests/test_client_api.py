"""API-Tokens + Client-API (Client-Pack im Kachelformat der lokalen App)."""

import io
import json
import zipfile

from fastapi.testclient import TestClient

from app.main import app

PACK_MANIFEST = {
    "format": 1,
    "map_name": "Arland",
    "calibration": {"offset_x": 1.5, "offset_z": -2.0, "scale_x": 1.0, "scale_z": 1.0},
}
QUALITY_CFG = {
    "world_min": {"x": 150.0, "z": 150.0}, "world_max": {"x": 3950.0, "z": 3950.0},
    "image_width": 16384, "image_height": 16384, "tile_size": 256, "max_zoom": 4,
    "invert_z": True, "tile_format": "webp",
}


def _pack_zip(extra: dict[str, bytes] | None = None, manifest: dict | None = None) -> bytes:
    files = {
        "clientpack.json": json.dumps(manifest or PACK_MANIFEST),
        "map_config.json": json.dumps({"layers": ["Satellite"], "default_layer": "Satellite"}),
        "Satellite/map_config.json": json.dumps({"qualities": ["Mid"], "default_quality": "Mid"}),
        "Satellite/Mid/map_config.json": json.dumps(QUALITY_CFG),
        "Satellite/Mid/tiles/0/0/0.webp": b"RIFF-fake-webp",
        "peaks.json": "[]",
    }
    files.update(extra or {})
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    return buf.getvalue()


def _make_map(admin, map_id="arland"):
    from app.db import SessionLocal
    from app.models import Map, now

    admin.post("/api/maps", json={"id": map_id, "name": "Arland", "url": "http://x.invalid/a.zip"})
    admin.delete(f"/api/maps/{map_id}/client-pack")  # Testdaten sind über Tests hinweg geteilt
    with SessionLocal() as db:
        m = db.get(Map, map_id)
        m.status = "ready"
        m.imported_at = now()
        db.commit()


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
    assert c.get("/api/maps").status_code == 401
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


def test_client_pack_upload_and_serve(admin):
    _make_map(admin)
    assert admin.post("/api/maps/arland/client-pack", content=_pack_zip()).status_code == 200

    c = _bearer(_new_token(admin)["token"])
    ping = c.get("/api/client/ping").json()
    assert ping["protocol"] == 1
    m = next(x for x in ping["maps"] if x["id"] == "arland")
    pack = m["client_pack"]
    assert pack["map_name"] == "Arland"
    assert pack["layers"]["Satellite"]["qualities"] == ["Mid"]
    assert pack["calibration"]["offset_x"] == 1.5
    assert pack["version"]

    r = c.get("/api/client/maps/arland/files/Satellite/Mid/tiles/0/0/0.webp")
    assert r.status_code == 200 and r.content == b"RIFF-fake-webp"
    assert r.headers["content-type"] == "image/webp"
    assert c.get("/api/client/maps/arland/files/Satellite/Mid/map_config.json").json()["max_zoom"] == 4
    assert c.get("/api/client/maps/arland/files/Satellite/Mid/tiles/9/9/9.webp").status_code == 404


def test_client_pack_path_traversal_and_internal_files(admin):
    _make_map(admin)
    admin.post("/api/maps/arland/client-pack", content=_pack_zip())
    c = _bearer(_new_token(admin)["token"])
    base = "/api/client/maps/arland/files/"
    assert c.get(base + ".info.json").status_code == 404           # Server-Metadaten
    assert c.get(base + "..%2f..%2fsecret.json").status_code == 404
    assert c.get(base + "Satellite/../../x.json").status_code in (404,)
    assert c.get("/api/client/maps/..%2f/files/clientpack.json").status_code == 404


def test_client_pack_rejects_bad_archives(admin):
    _make_map(admin)
    post = lambda body: admin.post("/api/maps/arland/client-pack", content=body)  # noqa: E731
    assert post(b"not a zip").status_code == 400
    assert post(_pack_zip({"evil.py": b"print(1)"})).status_code == 400          # Endung
    assert post(_pack_zip({"../escape.json": b"{}"})).status_code == 400        # Zip-Slip
    assert post(_pack_zip({".hidden.json": b"{}"})).status_code == 400          # Dot-Datei
    assert post(_pack_zip(manifest={"format": 2, "map_name": "x"})).status_code == 400
    assert post(_pack_zip(manifest={"format": 1})).status_code == 400            # map_name fehlt
    # Nach Fehlversuchen existiert weiterhin kein halbes Pack.
    assert admin.get("/api/maps/arland/client-pack").json()["client_pack"] is None


def test_client_pack_admin_only_and_needs_map(admin):
    _make_map(admin)
    admin.post("/api/admin/users", json={"username": "tester3", "password": "tester3-pass-xx"})
    user = TestClient(app)
    user.post("/auth/login", json={"username": "tester3", "password": "tester3-pass-xx"})
    assert user.post("/api/maps/arland/client-pack", content=_pack_zip()).status_code == 403
    assert admin.post("/api/maps/gibtsnicht/client-pack", content=_pack_zip()).status_code == 404


def test_client_pack_replace_and_delete(admin):
    _make_map(admin)
    v1 = admin.post("/api/maps/arland/client-pack", content=_pack_zip()).json()["version"]
    v2 = admin.post(
        "/api/maps/arland/client-pack", content=_pack_zip({"peaks.json": "[1]"})
    ).json()["version"]
    assert v1 != v2

    assert admin.delete("/api/maps/arland/client-pack").json()["ok"] is True
    c = _bearer(_new_token(admin)["token"])
    assert c.get("/api/client/ping").json()["maps"] == []


def test_client_pack_survives_mercator_reimport_rmtree(admin):
    """Das Pack liegt außerhalb von maps/<id>/ — Re-Import löscht es nicht."""
    import shutil

    from app.services.maps_import import map_dir

    _make_map(admin)
    admin.post("/api/maps/arland/client-pack", content=_pack_zip())
    d = map_dir("arland")
    d.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(d)
    c = _bearer(_new_token(admin)["token"])
    assert len(c.get("/api/client/ping").json()["maps"]) == 1


def test_cookie_session_also_works_on_client_api(admin):
    assert admin.get("/api/client/ping").status_code == 200


def test_client_pack_with_mask_layers(admin):
    _make_map(admin)
    masks = {
        "map_config.json": json.dumps({"layers": ["Satellite"], "mask_layers": ["Hillshade"]}),
        "Mask_Hillshade/map_config.json": json.dumps({"qualities": ["Low"], "default_quality": "Low"}),
        "Mask_Hillshade/Low/map_config.json": json.dumps(QUALITY_CFG),
        "Mask_Hillshade/Low/tiles/0/0/0.webp": b"mask-tile",
    }
    info = admin.post("/api/maps/arland/client-pack", content=_pack_zip(masks)).json()
    assert info["masks"] == {"Hillshade": {"qualities": ["Low"], "default_quality": "Low"}}

    c = _bearer(_new_token(admin)["token"])
    assert c.get("/api/client/maps/arland/files/Mask_Hillshade/Low/tiles/0/0/0.webp").content == b"mask-tile"

    # declared mask without its manifest is rejected
    broken = {"map_config.json": json.dumps({"layers": ["Satellite"], "mask_layers": ["Slope"]})}
    assert admin.post("/api/maps/arland/client-pack", content=_pack_zip(broken)).status_code == 400
    bad_name = {"map_config.json": json.dumps({"layers": ["Satellite"], "mask_layers": ["../x"]})}
    assert admin.post("/api/maps/arland/client-pack", content=_pack_zip(bad_name)).status_code == 400

