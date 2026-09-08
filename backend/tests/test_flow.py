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

    def player_phases(p):
        return [x for x in admin.get(f"/plans/{p}/phases").json() if x["plane"] == "player"]

    snap = admin.get(f"/plans/{pid}/snapshot").json()
    assert snap["markers"] == [] and len(snap["layers"]) == 1
    # Standard-Phase "Base" (player) + automatisch gepaarte builder-Phase (admin sieht beide)
    assert [p["name"] for p in snap["phases"] if p["plane"] == "player"] == ["Base"]
    assert any(p["plane"] == "builder" and p["parent_id"] for p in snap["phases"])

    ph = admin.post(f"/plans/{pid}/phases", json={"name": "Angriff"})
    assert ph.status_code == 201
    phid = ph.json()["id"]
    assert ph.json()["plane"] == "player"
    assert len(player_phases(pid)) == 2
    # Missionsbau-Zwischenphase 1.1 unter der Angriff-Phase
    sub = admin.post(f"/plans/{pid}/phases", json={"name": "1.1", "plane": "builder", "parent_id": phid})
    assert sub.status_code == 201 and sub.json()["plane"] == "builder"
    admin.patch(f"/plans/{pid}/phases/{phid}", json={"notes": "# Plan\n- 1 Zug hält"})
    notes = {p["id"]: p["notes"] for p in admin.get(f"/plans/{pid}/snapshot").json()["phases"]}
    assert "1 Zug" in notes[phid]
    assert admin.delete(f"/plans/{pid}/phases/{phid}").status_code == 200
    assert len(player_phases(pid)) == 1
    # die Builder-Zwischenphase ist mit der Spieler-Phase weg
    assert sub.json()["id"] not in [p["id"] for p in admin.get(f"/plans/{pid}/phases").json()]

    # Ordner: anlegen, Plan verschieben, klonen in Ordner, Ordner löschen
    root = admin.post("/folders", json={"name": "Übung"}).json()
    sub = admin.post("/folders", json={"name": "Kompanie A", "parent_id": root["id"]}).json()
    assert admin.post(f"/plans/{pid}/move", json={"folder_id": sub["id"]}).json()["folder_id"] == sub["id"]
    cl = admin.post(f"/plans/{pid}/clone", json={"name": "Op Alpha 2", "folder_id": root["id"]})
    assert cl.status_code == 201 and cl.json()["folder_id"] == root["id"]
    # Plan direkt in einem Ordner anlegen
    inf = admin.post("/plans", json={"name": "In Ordner", "map_id": "m1", "folder_id": sub["id"]})
    assert inf.status_code == 201 and inf.json()["folder_id"] == sub["id"]
    assert admin.patch(f"/plans/{inf.json()['id']}", json={"name": "Umbenannt"}).json()["name"] == "Umbenannt"
    # Zyklus-Schutz
    assert admin.patch(f"/folders/{root['id']}", json={"parent_id": sub["id"]}).status_code == 400
    # Löschen zieht Inhalt eine Ebene hoch
    assert admin.delete(f"/folders/{sub['id']}").status_code == 200
    assert admin.get(f"/plans/{pid}").json()["folder_id"] == root["id"]

    # Papierkorb: löschen -> im Trash -> wiederherstellen -> weg aus Trash
    admin.delete(f"/plans/{pid}")
    assert pid in [p["id"] for p in admin.get("/plans/trash").json()]
    assert admin.get("/plans").json() == [] or pid not in [p["id"] for p in admin.get("/plans").json()]
    assert admin.post(f"/plans/{pid}/undelete").status_code == 200
    assert pid not in [p["id"] for p in admin.get("/plans/trash").json()]
    # erneut löschen + endgültig entfernen
    admin.delete(f"/plans/{pid}")
    assert admin.delete(f"/plans/{pid}/purge").status_code == 200
    assert admin.get(f"/plans/{pid}/snapshot").status_code == 404


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

        # Annotation (platzierbares Textfeld) — anlegen / ändern / löschen
        ws.send_json({"type": "annotation.create", "cid": "a1",
                      "data": {"world_x": 1.0, "world_y": 1.0, "text": "**Hinweis**"}})
        amsg = ws.receive_json()
        assert amsg["type"] == "annotation.upsert" and amsg["cid"] == "a1"
        aid = amsg["annotation"]["id"]
        ws.send_json({"type": "annotation.modify", "id": aid, "data": {"text": "neu", "width": 300}})
        assert ws.receive_json()["annotation"]["width"] == 300
        ws.send_json({"type": "annotation.delete", "id": aid})
        assert ws.receive_json() == {"type": "annotation.delete", "id": aid}

    assert len(admin.get(f"/plans/{pid}/snapshot").json()["markers"]) == 1
    assert admin.get(f"/plans/{pid}/snapshot").json()["annotations"] == []

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
    # gleiche ID erneut → ersetzt statt 409
    again = admin.post("/api/maps/import-from-source",
                       json={"id": "arl", "name": "Arland 2", "source_id": sid, "file": "arland_mappack_v1.zip"})
    assert again.status_code == 202 and again.json()["name"] == "Arland 2"

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


def test_mission_builder_planes(admin):
    """Builder-Phasen + deren Marker sind für Nicht-Missionsbauer unsichtbar."""
    from fastapi.testclient import TestClient

    from app.db import SessionLocal
    from app.main import app
    from app.models import Map, PlanACL, User, now
    from app.security import hash_password

    admin.post("/api/maps", json={"id": "mb", "name": "MB", "url": "http://x.invalid/a.zip"})
    with SessionLocal() as db:
        db.get(Map, "mb").status = "ready"
        db.get(Map, "mb").imported_at = now()
        db.add(User(username="grunt", password_hash=hash_password("grunt-pass-1234")))
        db.commit()
        gid = db.scalar(__import__("sqlalchemy").select(User.id).where(User.username == "grunt"))

    pid = admin.post("/plans", json={"name": "MBPlan", "map_id": "mb"}).json()["id"]
    admin.put(f"/plans/{pid}/acl", json=[
        {"subject_type": "user", "subject_id": admin.get("/auth/me").json()["id"], "level": "owner"},
        {"subject_type": "user", "subject_id": gid, "level": "editor",
         "can_place": True, "can_move": True, "can_delete": True, "can_draw": True},
    ])

    phases = admin.get(f"/plans/{pid}/phases").json()
    builder_ph = next(p for p in phases if p["plane"] == "builder")
    player_ph = next(p for p in phases if p["plane"] == "player")

    # Admin (= Missionsbauer) legt einen Marker auf der Builder-Phase an
    with admin.websocket_connect(f"/plans/{pid}/live") as ws:
        assert ws.receive_json()["mission_builder"] is True
        ws.receive_json()
        ws.send_json({"type": "marker.create", "cid": "b1", "data": {
            "sidc": "1", "world_x": 1.0, "world_y": 1.0, "phase_id": builder_ph["id"]}})
        ws.receive_json()
        ws.send_json({"type": "marker.create", "cid": "p1", "data": {
            "sidc": "1", "world_x": 2.0, "world_y": 2.0, "phase_id": player_ph["id"]}})
        ws.receive_json()

    # grunt (kein Missionsbauer): sieht nur die Spieler-Phase + den Spieler-Marker
    with TestClient(app) as c:
        c.post("/auth/login", json={"username": "grunt", "password": "grunt-pass-1234"})
        snap = c.get(f"/plans/{pid}/snapshot").json()
        assert all(p["plane"] == "player" for p in snap["phases"])
        assert [m["world_x"] for m in snap["markers"]] == [2.0]
        # grunt darf nicht auf einer Builder-Phase setzen
        with c.websocket_connect(f"/plans/{pid}/live") as ws:
            assert ws.receive_json()["mission_builder"] is False
            ws.receive_json()
            ws.send_json({"type": "marker.create", "cid": "x", "data": {
                "sidc": "1", "world_x": 0.0, "world_y": 0.0, "phase_id": builder_ph["id"]}})
            assert ws.receive_json()["type"] == "reject"


def test_orbat_library(admin):
    """ORBAT anlegen, Baum bauen, an einen Plan hängen, freigegebene Spieler-Sicht."""
    from fastapi.testclient import TestClient

    from app.db import SessionLocal
    from app.main import app
    from app.models import Map, User, now
    from app.security import hash_password

    admin.post("/api/maps", json={"id": "ob", "name": "OB", "url": "http://x.invalid/a.zip"})
    with SessionLocal() as db:
        db.get(Map, "ob").status = "ready"
        db.get(Map, "ob").imported_at = now()
        db.add(User(username="pl", password_hash=hash_password("pl-pass-123456")))
        db.commit()
        plid_user = db.scalar(__import__("sqlalchemy").select(User.id).where(User.username == "pl"))

    # admin ist Missionsbau (Admin impliziert)
    o = admin.post("/api/orbats", json={"name": "1. Kompanie", "affiliation": "hostile"})
    assert o.status_code == 201
    oid = o.json()["id"]
    root = admin.post(f"/api/orbats/{oid}/nodes", json={"name": "1. Zug", "sidc": "S", "qty_planned": 3}).json()
    child = admin.post(f"/api/orbats/{oid}/nodes",
                       json={"name": "1. Gruppe", "parent_id": root["id"], "qty_planned": 1,
                             "rel_visible": True, "rel_show_type": True, "rel_strength": 50}).json()
    full = admin.get(f"/api/orbats/{oid}").json()
    assert len(full["nodes"]) == 2 and full["level"] == "editor"

    pid = admin.post("/plans", json={"name": "OBPlan", "map_id": "ob"}).json()["id"]
    admin.put(f"/plans/{pid}/acl", json=[
        {"subject_type": "user", "subject_id": admin.get("/auth/me").json()["id"], "level": "owner"},
        {"subject_type": "user", "subject_id": plid_user, "level": "viewer"},
    ])
    assert admin.post(f"/plans/{pid}/orbats", json={"orbat_id": oid}).status_code == 201

    # Missionsbauer (admin) sieht die volle Struktur
    mb_view = admin.get(f"/plans/{pid}/orbats").json()
    assert mb_view[0]["released"] is False and len(mb_view[0]["nodes"]) == 2

    # Spieler sieht nur den freigegebenen Knoten, Stärke ~50 % von 1 = 1 (gerundet)
    with TestClient(app) as c:
        c.post("/auth/login", json={"username": "pl", "password": "pl-pass-123456"})
        pv = c.get(f"/plans/{pid}/orbats").json()
        assert pv[0]["released"] is True
        assert [n["id"] for n in pv[0]["nodes"]] == [child["id"]]
        # Spieler darf die ORBAT-Bibliothek nicht sehen
        assert c.get("/api/orbats").status_code == 403


def test_orbat_marker_link(admin):
    """Marker ↔ ORBAT-Knoten: Status-Sync in beide Richtungen + freigegebener
    Feind-Marker in der Spieler-Sicht."""
    from fastapi.testclient import TestClient

    from app.db import SessionLocal
    from app.main import app
    from app.models import Map, User, now
    from app.security import hash_password

    admin.post("/api/maps", json={"id": "oc", "name": "OC", "url": "http://x.invalid/a.zip"})
    with SessionLocal() as db:
        db.get(Map, "oc").status = "ready"
        db.get(Map, "oc").imported_at = now()
        db.add(User(username="plc", password_hash=hash_password("plc-pass-123456")))
        db.commit()
        plc_id = db.scalar(__import__("sqlalchemy").select(User.id).where(User.username == "plc"))

    oid = admin.post("/api/orbats", json={"name": "Feind", "affiliation": "hostile"}).json()["id"]
    node = admin.post(f"/api/orbats/{oid}/nodes", json={
        "name": "Panzerzug", "sidc": "100600000000000000000000000000", "qty_planned": 3,
        "rel_visible": True, "rel_show_type": True, "rel_strength": 100,
    }).json()
    assert node["qty_current"] == 3

    pid = admin.post("/plans", json={"name": "OCPlan", "map_id": "oc"}).json()["id"]
    admin.put(f"/plans/{pid}/acl", json=[
        {"subject_type": "user", "subject_id": admin.get("/auth/me").json()["id"], "level": "owner"},
        {"subject_type": "user", "subject_id": plc_id, "level": "viewer"},
    ])
    admin.post(f"/plans/{pid}/orbats", json={"orbat_id": oid})

    phases = admin.get(f"/plans/{pid}/phases").json()
    builder_ph = next(p for p in phases if p["plane"] == "builder")
    player_ph = next(p for p in phases if p["plane"] == "player")

    with admin.websocket_connect(f"/plans/{pid}/live") as ws:
        ws.receive_json(); ws.receive_json()
        ws.send_json({"type": "marker.create", "cid": "m1", "data": {
            "sidc": "100600000000000000000000000000", "world_x": 5.0, "world_y": 5.0,
            "phase_id": builder_ph["id"], "orbat_node_id": node["id"], "orbat_strength": 2}})
        mid = ws.receive_json()["marker"]["id"]
        # Marker zerstört -> Knoten übernimmt Status, Ist-Stärke -2
        ws.send_json({"type": "marker.modify", "id": mid, "data": {
            "sidc": "100600400000000000000000000000"}})
        ws.receive_json()

    n2 = next(n for n in admin.get(f"/api/orbats/{oid}").json()["nodes"] if n["id"] == node["id"])
    assert n2["status"] == "destroyed" and n2["qty_current"] == 1

    # Knoten wieder einsatzbereit -> Marker-SIDC zieht nach
    admin.patch(f"/api/orbats/{oid}/nodes/{node['id']}", json={"status": "active"})
    snap = admin.get(f"/plans/{pid}/snapshot").json()
    linked = next(m for m in snap["markers"] if m.get("orbat_node_id") == node["id"])
    assert linked["sidc"][6] == "0"

    # Spieler: freigegebener Feind-Marker auf der Spieler-Phase, als Anzeige markiert
    with TestClient(app) as c:
        c.post("/auth/login", json={"username": "plc", "password": "plc-pass-123456"})
        psnap = c.get(f"/plans/{pid}/snapshot").json()
        rel = [m for m in psnap["markers"] if m.get("released")]
        assert len(rel) == 1
        assert rel[0]["phase_id"] == player_ph["id"] and rel[0]["locked"] is True
