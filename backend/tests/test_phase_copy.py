"""Phase kopieren: Inhalt in neue/vorhandene Phase desselben oder eines anderen Plans."""
from tests.test_live_hardening import _plan, _skip_hello

SIDC = "100310000011010000000000000000"


def _recv(ws, typ):
    while True:
        m = ws.receive_json()
        if m["type"] == typ:
            return m


def _seed(admin):
    pid = _plan(admin)
    phases = admin.get(f"/plans/{pid}/phases").json()
    ph = next(p for p in phases if p["plane"] == "player")
    with admin.websocket_connect(f"/plans/{pid}/live") as ws:
        _skip_hello(ws)
        ws.send_json({"type": "marker.create", "cid": "m", "data": {
            "sidc": SIDC, "world_x": 1, "world_y": 2, "unit_text": "A", "ai_text": "", "phase_id": ph["id"],
            "locked": False, "timestamp_visible": True, "rotation_degrees": -1,
        }})
        _recv(ws, "marker.upsert")
    return pid, ph["id"]


def test_copy_to_new_phase_in_other_plan(admin):
    pid, ph = _seed(admin)
    other = _plan(admin)
    r = admin.post(f"/plans/{pid}/phases/{ph}/copy", json={"target_plan_id": other, "new_phase_name": "Kopie"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["markers"] == 1 and out["plan_id"] == other
    snap = admin.get(f"/plans/{other}/snapshot").json()
    assert [m["unit_text"] for m in snap["markers"] if m["phase_id"] == out["phase_id"]] == ["A"]
    names = [p["name"] for p in admin.get(f"/plans/{other}/phases").json()]
    assert "Kopie" in names


def test_copy_into_existing_phase_same_plan(admin):
    pid, ph = _seed(admin)
    r = admin.post(f"/plans/{pid}/phases", json={"name": "Ziel"})
    dst = r.json()["id"]
    r = admin.post(f"/plans/{pid}/phases/{ph}/copy", json={"target_plan_id": pid, "target_phase_id": dst})
    assert r.status_code == 200 and r.json()["markers"] == 1
    snap = admin.get(f"/plans/{pid}/snapshot").json()
    assert sum(1 for m in snap["markers"] if m["phase_id"] == dst) == 1
    assert sum(1 for m in snap["markers"] if m["phase_id"] == ph) == 1
