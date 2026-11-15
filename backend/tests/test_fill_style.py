"""Flächen-Füllung: Muster (diag/vert/horiz/cross/solid) und Stärke werden gespeichert, begrenzt und ausgeliefert."""
from tests.test_live_hardening import _plan, _skip_hello

TRI = [[0, 0], [10, 0], [5, 8]]


def _commit(ws, **extra):
    data = {"kind": "phaseline", "points": TRI, "color": -1, "width": 2, "closed": True, **extra}
    ws.send_json({"type": "stroke.commit", "cid": "c", "data": data})
    while True:
        m = ws.receive_json()
        if m["type"] == "stroke.upsert":
            return m.get("stroke") or m.get("data") or m


def test_fill_pattern_and_strength(admin):
    pid = _plan(admin)
    with admin.websocket_connect(f"/plans/{pid}/live") as ws:
        _skip_hello(ws)
        s = _commit(ws, fill_pattern="cross", fill_strength=60)
        assert s["fill_pattern"] == "cross" and s["fill_strength"] == 60
        sid = s["id"]
        # ungültige Werte -> Standard / Begrenzung
        s2 = _commit(ws, fill_pattern="wavy", fill_strength=500)
        assert s2["fill_pattern"] == "diag" and s2["fill_strength"] == 100
        ws.send_json({"type": "stroke.modify", "id": sid, "data": {"fill_pattern": "vert", "fill_strength": 1}})
        while True:
            m = ws.receive_json()
            if m["type"] == "stroke.upsert":
                s3 = m.get("stroke") or m.get("data") or m
                break
        assert s3["fill_pattern"] == "vert" and s3["fill_strength"] == 5
    snap = admin.get(f"/plans/{pid}/snapshot").json()
    got = {x["id"]: x for x in snap["strokes"]}
    assert got[sid]["fill_pattern"] == "vert"
