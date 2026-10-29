"""WS-Härtung: kaputte Nachrichten -> reject, Phase aus fremdem Plan, Punkte-Limit,
ORBAT-Verlust bei neuer Verknüpfung, Wiederherstellung mit Broadcast."""
from tests.test_plan_images import _make_map


def _plan(admin, name="Hart"):
    _make_map(admin)
    return admin.post("/plans", json={"name": name, "map_id": "m1"}).json()["id"]


def _skip_hello(ws):
    assert ws.receive_json()["type"] == "hello"
    assert ws.receive_json()["type"] == "presence.join"


def test_bad_messages_reject_not_disconnect(admin):
    pid = _plan(admin)
    with admin.websocket_connect(f"/plans/{pid}/live") as ws:
        _skip_hello(ws)
        ws.send_json({"type": "marker.move", "id": "x"})  # world_x fehlt -> KeyError
        assert ws.receive_json()["type"] == "reject"
        ws.send_json({"type": "stroke.commit", "cid": "s", "data": {"points": "kaputt"}})
        assert ws.receive_json()["type"] == "reject"
        ws.send_json({"type": "stroke.commit", "cid": "s2", "data": {"points": [[0, 0]] * 5001}})
        assert ws.receive_json()["type"] == "reject"
        ws.send_json([1, 2, 3])  # kein Objekt -> ignoriert
        # Verbindung lebt weiter
        ws.send_json({"type": "annotation.create", "cid": "a", "data": {"text": "ok"}})
        assert ws.receive_json()["type"] == "annotation.upsert"


def test_phase_of_other_plan_rejected(admin):
    p1 = _plan(admin, "A")
    p2 = admin.post("/plans", json={"name": "B", "map_id": "m1"}).json()["id"]
    foreign = admin.get(f"/plans/{p2}/phases").json()[0]["id"]
    with admin.websocket_connect(f"/plans/{p1}/live") as ws:
        _skip_hello(ws)
        ws.send_json({"type": "annotation.create", "cid": "a", "data": {"text": "x", "phase_id": foreign}})
        msg = ws.receive_json()
        assert msg["type"] == "reject" and msg["cid"] == "a"


def test_orbat_loss_on_first_link_and_restore_broadcast(admin):
    pid = _plan(admin, "Orbat")
    from app.db import SessionLocal
    from app.models import Orbat, OrbatNode, PlanOrbat

    with SessionLocal() as db:
        o = Orbat(name="O")
        db.add(o)
        db.flush()
        n = OrbatNode(orbat_id=o.id, name="Zug", qty_current=10)
        db.add(n)
        db.add(PlanOrbat(plan_id=pid, orbat_id=o.id))
        db.commit()
        nid = n.id
    destroyed = "10012500001101000000"
    from app.sidc_status import sidc_with_status

    destroyed = sidc_with_status(destroyed, "destroyed")
    with admin.websocket_connect(f"/plans/{pid}/live") as ws:
        _skip_hello(ws)
        ws.send_json({"type": "marker.create", "cid": "m", "data": {
            "sidc": destroyed, "world_x": 0, "world_y": 0, "orbat_strength": 3}})
        mid = ws.receive_json()["marker"]["id"]
        ws.send_json({"type": "marker.modify", "id": mid, "data": {"orbat_node_id": nid}})
        assert ws.receive_json()["type"] == "marker.upsert"
        with SessionLocal() as db:
            assert db.get(OrbatNode, nid).qty_current == 7  # Verlust bei Erstverknüpfung abgezogen
        vid = admin.post(f"/plans/{pid}/versions", json={"label": "V"}).json()["id"]
        ws.send_json({"type": "marker.delete", "id": mid})
        assert ws.receive_json()["type"] == "marker.delete"
        with SessionLocal() as db:
            assert db.get(OrbatNode, nid).qty_current == 10
        assert admin.post(f"/plans/{pid}/restore/{vid}").status_code == 200
        assert ws.receive_json()["type"] == "phases.changed"  # Restore wird gebroadcastet
        with SessionLocal() as db:
            assert db.get(OrbatNode, nid).qty_current == 7  # ORBAT-Zähler nach Restore abgeglichen


def test_open_socket_closed_when_plan_deleted(admin, monkeypatch):
    import pytest
    from starlette.websockets import WebSocketDisconnect

    from app.routers import live

    monkeypatch.setattr(live, "AUTH_RECHECK_SECONDS", 0.1)
    pid = _plan(admin, "Weg")
    with admin.websocket_connect(f"/plans/{pid}/live") as ws:
        _skip_hello(ws)
        admin.delete(f"/plans/{pid}")  # Plan in den Papierkorb -> Rechte erloschen
        with pytest.raises(WebSocketDisconnect):
            for _ in range(20):
                ws.receive_json()


def test_sync_endpoint_broadcasts_live_event(admin):
    """Layer-Create (Sync-Endpunkt im Threadpool) sendet weiterhin ein Live-Event."""
    pid = _plan(admin, "SyncBC")
    with admin.websocket_connect(f"/plans/{pid}/live") as ws:
        _skip_hello(ws)
        r = admin.post(f"/plans/{pid}/layers", json={"name": "Neu"})
        assert r.status_code == 201
        msg = ws.receive_json()
        assert msg["type"] == "layers.changed"
        assert any(ly["name"] == "Neu" for ly in msg["layers"])
