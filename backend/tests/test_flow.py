"""Kern-Durchstich: Auth, Rechte, Plan-CRUD, Live-Marker mit Server-Autorität."""


def _make_map(admin):
    admin.post("/api/maps", json={"id": "m1", "name": "M1", "url": "http://x.invalid/a.zip"})
    # Import scheitert (Fake-URL) -> Status direkt auf 'ready' setzen für den Test
    from app.db import SessionLocal
    from app.models import Map, now

    with SessionLocal() as db:
        m = db.get(Map, "m1")
        m.status = "ready"
        m.imported_at = now()
        db.commit()


def test_health(client):
    assert client.get("/healthz").json()["status"] == "ok"


def test_login_required(client):
    assert client.get("/auth/me").status_code == 401
    assert client.get("/plans").status_code == 401


def test_bad_login(client):
    assert client.post("/auth/login", json={"username": "admin", "password": "wrong"}).status_code == 401


def test_plan_lifecycle_and_permissions(admin):
    _make_map(admin)
    r = admin.post("/plans", json={"name": "Op Alpha", "map_id": "m1"})
    assert r.status_code == 201
    pid = r.json()["id"]

    plans = admin.get("/plans").json()
    assert plans[0]["level"] == "owner"

    snap = admin.get(f"/plans/{pid}/snapshot").json()
    assert snap["markers"] == [] and len(snap["layers"]) == 1
    # Standard-Phase "Base" wird beim Anlegen erzeugt
    assert [p["name"] for p in snap["phases"]] == ["Base"]

    ph = admin.post(f"/plans/{pid}/phases", json={"name": "Angriff"})
    assert ph.status_code == 201
    phid = ph.json()["id"]
    assert len(admin.get(f"/plans/{pid}/phases").json()) == 2
    admin.patch(f"/plans/{pid}/phases/{phid}", json={"notes": "# Plan\n- 1 Zug hält"})
    assert "1 Zug" in admin.get(f"/plans/{pid}/snapshot").json()["phases"][1]["notes"]
    assert admin.delete(f"/plans/{pid}/phases/{phid}").status_code == 200
    assert len(admin.get(f"/plans/{pid}/phases").json()) == 1

    # Ordner: anlegen, Plan verschieben, klonen in Ordner, Ordner löschen
    root = admin.post("/folders", json={"name": "Übung"}).json()
    sub = admin.post("/folders", json={"name": "Kompanie A", "parent_id": root["id"]}).json()
    assert admin.post(f"/plans/{pid}/move", json={"folder_id": sub["id"]}).json()["folder_id"] == sub["id"]
    cl = admin.post(f"/plans/{pid}/clone", json={"name": "Op Alpha 2", "folder_id": root["id"]})
    assert cl.status_code == 201 and cl.json()["folder_id"] == root["id"]
    # Zyklus-Schutz
    assert admin.patch(f"/folders/{root['id']}", json={"parent_id": sub["id"]}).status_code == 400
    # Löschen zieht Inhalt eine Ebene hoch
    assert admin.delete(f"/folders/{sub['id']}").status_code == 200
    assert admin.get(f"/plans/{pid}").json()["folder_id"] == root["id"]


def test_live_marker_authority(admin):
    _make_map(admin)
    pid = admin.post("/plans", json={"name": "Op Bravo", "map_id": "m1"}).json()["id"]

    with admin.websocket_connect(f"/plans/{pid}/live") as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello" and hello["caps"]["place"] is True
        assert ws.receive_json()["type"] == "presence.join"
        ws.send_json({
            "type": "marker.create",
            "cid": "c1",
            "data": {"sidc": "10012500001101000000", "world_x": 1.0, "world_y": 2.0},
        })
        msg = ws.receive_json()
        assert msg["type"] == "marker.upsert" and msg["cid"] == "c1"
        mid = msg["marker"]["id"]

        ws.send_json({"type": "marker.move", "id": mid, "world_x": 9.0, "world_y": 9.0})
        assert ws.receive_json()["marker"]["world_x"] == 9.0

        ws.send_json({"type": "marker.lock", "id": mid, "locked": True})
        assert ws.receive_json()["marker"]["locked"] is True

    assert len(admin.get(f"/plans/{pid}/snapshot").json()["markers"]) == 1

    # Versionsverlauf: sichern, Marker ändern, zurück, Sicherungs-Version entsteht
    v = admin.post(f"/plans/{pid}/versions", json={"label": "Stand A"})
    assert v.status_code == 201
    vid = v.json()["id"]
    rows = admin.get(f"/plans/{pid}/versions").json()
    assert rows[0]["label"] == "Stand A" and rows[0]["marker_count"] == 1
    with admin.websocket_connect(f"/plans/{pid}/live") as ws:
        for _ in range(2):
            ws.receive_json()
        ws.send_json({"type": "marker.delete", "id": mid})
        ws.receive_json()
    assert admin.get(f"/plans/{pid}/snapshot").json()["markers"] == []
    assert admin.post(f"/plans/{pid}/restore/{vid}").status_code == 200
    assert len(admin.get(f"/plans/{pid}/snapshot").json()["markers"]) == 1
    assert len(admin.get(f"/plans/{pid}/versions").json()) == 2  # + Sicherung


def test_granular_caps_block_ops(admin):
    from app.db import SessionLocal
    from app.models import Map, User, now
    from app.security import hash_password

    admin.post("/api/maps", json={"id": "mc", "name": "MC", "url": "http://x.invalid/a.zip"})
    with SessionLocal() as db:
        db.get(Map, "mc").status = "ready"
        db.get(Map, "mc").imported_at = now()
        u = User(username="mover", password_hash=hash_password("mover-pass-1234"))
        db.add(u)
        db.commit()
        uid = u.id

    pid = admin.post("/plans", json={"name": "Caps", "map_id": "mc"}).json()["id"]
    # mover darf bewegen, aber nicht setzen/löschen/malen
    me = admin.get("/auth/me").json()["id"]
    admin.put(f"/plans/{pid}/acl", json=[
        {"subject_type": "user", "subject_id": me, "level": "owner"},
        {"subject_type": "user", "subject_id": uid, "level": "editor",
         "can_place": False, "can_move": True, "can_delete": False, "can_draw": False},
    ])

    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as c2:
        c2.post("/auth/login", json={"username": "mover", "password": "mover-pass-1234"})
        with c2.websocket_connect(f"/plans/{pid}/live") as ws:
            hello = ws.receive_json()
            assert hello["caps"] == {"place": False, "move": True, "delete": False, "draw": False}
            ws.receive_json()  # presence.join (selbst)
            ws.send_json({"type": "marker.create", "cid": "x",
                          "data": {"sidc": "1", "world_x": 0, "world_y": 0}})
            r = ws.receive_json()
            assert r["type"] == "reject" and "place" in r["reason"]



def test_map_source_gitea(admin, monkeypatch):
    import httpx

    from app.routers import map_sources

    r = admin.post("/api/map-sources", json={"url": "https://git.example/root/ReforgerMapData"})
    assert r.status_code == 201
    s = r.json()
    assert s["base_url"] == "https://git.example" and s["repo"] == "root/ReforgerMapData"
    assert s["has_token"] is False
    sid = s["id"]

    class _Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return [
                {"type": "file", "name": "arland_mappack_v1.zip", "size": 123,
                 "download_url": "https://git.example/root/ReforgerMapData/raw/arland_mappack_v1.zip"},
                {"type": "file", "name": "readme.md", "size": 10, "download_url": "x"},
            ]

    monkeypatch.setattr(httpx, "get", lambda *a, **k: _Resp())

    files = admin.get(f"/api/map-sources/{sid}/files").json()
    assert [f["name"] for f in files] == ["arland_mappack_v1.zip"]

    from app.routers import maps as maps_router

    called: dict = {}
    monkeypatch.setattr(maps_router, "run_import", lambda *a, **k: called.setdefault("hit", (a, k)))
    imp = admin.post("/api/maps/import-from-source",
                     json={"id": "arl", "name": "Arland", "source_id": sid, "file": "arland_mappack_v1.zip"})
    assert imp.status_code == 202
    assert called["hit"][1]["url"].endswith("arland_mappack_v1.zip")

    assert admin.delete(f"/api/map-sources/{sid}").status_code == 200


def test_public_share(admin):
    from app.db import SessionLocal
    from app.models import Map, now

    admin.post("/api/maps", json={"id": "ps", "name": "PS", "url": "http://x.invalid/a.zip"})
    with SessionLocal() as db:
        db.get(Map, "ps").status = "ready"
        db.get(Map, "ps").imported_at = now()
        db.commit()
    pid = admin.post("/plans", json={"name": "Public", "map_id": "ps"}).json()["id"]
    tok = admin.post(f"/plans/{pid}/shares", json={"label": "test"}).json()["token"]


    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as anon:  # kein Login-Cookie
        r = anon.get(f"/public/plans/{tok}")
        assert r.status_code == 200 and r.json()["readonly"] is True
        assert anon.get(f"/public/plans/{tok}/style.json").status_code == 200

    admin.delete(f"/plans/{pid}/shares/{tok}")
    with TestClient(app) as anon:
        assert anon.get(f"/public/plans/{tok}").status_code == 404
