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


def test_live_marker_authority(admin):
    _make_map(admin)
    pid = admin.post("/plans", json={"name": "Op Bravo", "map_id": "m1"}).json()["id"]

    with admin.websocket_connect(f"/plans/{pid}/live") as ws:
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
