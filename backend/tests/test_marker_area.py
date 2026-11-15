"""Bereich um einen Marker: speichern, Stil bereinigen, wandert beim Verschieben mit."""
from tests.test_live_hardening import _plan, _skip_hello

SIDC = "100310000011010000000000000000"


def _recv(ws, typ):
    while True:
        m = ws.receive_json()
        if m["type"] == typ:
            return m


def test_marker_area_roundtrip_and_move(admin):
    pid = _plan(admin)
    with admin.websocket_connect(f"/plans/{pid}/live") as ws:
        _skip_hello(ws)
        ws.send_json({"type": "marker.create", "cid": "m", "data": {
            "sidc": SIDC, "world_x": 10, "world_y": 20, "unit_text": "", "ai_text": "",
            "locked": False, "timestamp_visible": True, "rotation_degrees": -1,
        }})
        mk = _recv(ws, "marker.upsert")["marker"]
        assert mk["area"] is None
        area = {"pts": [[0, 0], [10, 0], [5, 8]], "closed": True, "color": "#FF0000", "pattern": "cross", "strength": 999}
        ws.send_json({"type": "marker.modify", "id": mk["id"], "data": {"area": area}})
        a = _recv(ws, "marker.upsert")["marker"]["area"]
        assert a["closed"] is True and a["color"] == "#ff0000" and a["pattern"] == "cross" and a["strength"] == 100
        # ungültiger Stil wird verworfen
        ws.send_json({"type": "marker.modify", "id": mk["id"], "data": {"area": {**area, "color": "rot", "pattern": "x"}}})
        a2 = _recv(ws, "marker.upsert")["marker"]["area"]
        assert "color" not in a2 and "pattern" not in a2
        # Verschieben: Bereich wandert um dasselbe Delta (+5, +5)
        ws.send_json({"type": "marker.move", "id": mk["id"], "world_x": 15, "world_y": 25})
        moved = _recv(ws, "marker.upsert")["marker"]
        assert moved["area"]["pts"][0] == [5, 5] and moved["area"]["pts"][2] == [10, 13]
    snap = admin.get(f"/plans/{pid}/snapshot").json()
    assert snap["markers"][0]["area"]["pts"][1] == [15, 5]
