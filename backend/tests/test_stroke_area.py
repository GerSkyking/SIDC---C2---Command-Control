"""Benannte Flächen beim Zeichnen: Stroke.closed / name / sidc / fill (Migration 0046)."""
import itertools

import pytest
from fastapi.testclient import TestClient

from app.main import app
from tests.test_live_hardening import _skip_hello
from tests.test_plan_refs import _ws
from tests.test_project_tools import _map, _user

_n = itertools.count(1)  # eigener Präfix "sa" (Benutzernamen kollidieren sonst)

SQUARE = [[0.0, 0.0], [0.01, 0.0], [0.01, 0.01], [0.0, 0.01]]
SIDC20 = "10032500001101000000"
SIDC30 = "130325000011010000000000000000"


@pytest.fixture
def world(admin):
    k = next(_n)
    ed, _ = _user(admin, f"sa{k}a", can_create_plans=True)
    _map(admin)
    plan = ed.post("/plans", json={"name": "Flächen", "map_id": "m1"}).json()["id"]
    return dict(admin=admin, ed=ed, plan=plan)


def _commit(c, plan, **data):
    data.setdefault("points", SQUARE)
    msg = _ws(c, plan, type="stroke.commit", cid="s", data=data)
    assert msg["type"] == "stroke.upsert", msg
    return msg["stroke"]


def _snap_strokes(c, plan):
    return {s["id"]: s for s in c.get(f"/plans/{plan}/snapshot").json()["strokes"]}


def test_create_named_area(world):
    w = world
    s = _commit(w["ed"], w["plan"], closed=True, name="  Ziel   Alpha \n", sidc=SIDC20, color=0xFF0000)
    assert s["closed"] is True and s["name"] == "Ziel Alpha" and s["sidc"] == SIDC20 and s["fill"] is True
    s2 = _commit(w["ed"], w["plan"], closed=True, sidc=SIDC30, fill=False)
    assert s2["sidc"] == SIDC30 and s2["fill"] is False
    # Klassischer 15-stelliger Buchstaben-SIDC (wird groß geschrieben)
    s3 = _commit(w["ed"], w["plan"], closed=True, sidc="gfgpgaa-------x")
    assert s3["sidc"] == "GFGPGAA-------X"
    # Ohne Angaben: alte Form (offene Linie)
    s4 = _commit(w["ed"], w["plan"])
    assert s4["closed"] is False and s4["name"] == "" and s4["sidc"] == "" and s4["fill"] is True


def test_validation(world):
    w = world
    # Geschlossen braucht mindestens 3 Punkte
    s = _commit(w["ed"], w["plan"], points=[[0, 0], [1, 1]], closed=True)
    assert s["closed"] is False
    # closed muss echtes true sein (kein "yes"/1)
    assert _commit(w["ed"], w["plan"], closed="yes")["closed"] is False
    # ungültige SIDCs werden verworfen
    for bad in ("123", "1003250000110100000X", "<script>alert(1)</script>", 10032500001101000000, "1" * 25):
        assert _commit(w["ed"], w["plan"], closed=True, sidc=bad)["sidc"] == ""
    # Name: kein String -> leer, zu lang -> gekürzt
    assert _commit(w["ed"], w["plan"], name=["x"])["name"] == ""
    assert len(_commit(w["ed"], w["plan"], name="A" * 500)["name"]) == 128


def test_modify(world):
    w = world
    s = _commit(w["ed"], w["plan"])
    msg = _ws(w["ed"], w["plan"], type="stroke.modify", id=s["id"],
              data={"closed": True, "name": "Raum Nord", "sidc": SIDC20, "fill": False})
    st = msg["stroke"]
    assert st["closed"] is True and st["name"] == "Raum Nord" and st["sidc"] == SIDC20 and st["fill"] is False
    # Ungültiger SIDC löscht, Name bleibt unangetastet, wenn nicht mitgeschickt
    st = _ws(w["ed"], w["plan"], type="stroke.modify", id=s["id"], data={"sidc": "kaputt"})["stroke"]
    assert st["sidc"] == "" and st["name"] == "Raum Nord" and st["closed"] is True
    # Punkte auf 2 reduziert -> nicht mehr geschlossen
    st = _ws(w["ed"], w["plan"], type="stroke.modify", id=s["id"], data={"points": [[0, 0], [1, 1]]})["stroke"]
    assert st["closed"] is False
    # Wieder schließen mit 2 Punkten geht nicht
    st = _ws(w["ed"], w["plan"], type="stroke.modify", id=s["id"], data={"closed": True})["stroke"]
    assert st["closed"] is False


def test_snapshot_clone_version(world):
    w = world
    ed, plan = w["ed"], w["plan"]
    s = _commit(ed, plan, closed=True, name="Sammelraum", sidc=SIDC20, fill=False)
    snap = _snap_strokes(ed, plan)[s["id"]]
    assert (snap["closed"], snap["name"], snap["sidc"], snap["fill"]) == (True, "Sammelraum", SIDC20, False)

    # Duplizieren behält die Felder
    cl = ed.post(f"/plans/{plan}/clone", json={"name": "Klon"})
    assert cl.status_code == 201, cl.text
    cs = list(_snap_strokes(ed, cl.json()["id"]).values())
    assert [(x["closed"], x["name"], x["sidc"], x["fill"]) for x in cs] == [(True, "Sammelraum", SIDC20, False)]

    # Version sichern, Fläche ändern, wiederherstellen
    vid = ed.post(f"/plans/{plan}/versions", json={"label": "A"}).json()["id"]
    _ws(ed, plan, type="stroke.modify", id=s["id"], data={"name": "anders", "closed": False, "sidc": ""})
    assert ed.post(f"/plans/{plan}/restore/{vid}").status_code == 200
    rs = list(_snap_strokes(ed, plan).values())
    assert [(x["closed"], x["name"], x["sidc"], x["fill"]) for x in rs] == [(True, "Sammelraum", SIDC20, False)]


def test_restore_old_version_without_fields(world):
    """Ältere Versionen ohne die neuen Felder lassen sich weiter wiederherstellen (Standardwerte)."""
    from app.db import SessionLocal
    from app.models import PlanVersion

    w = world
    ed, plan = w["ed"], w["plan"]
    with SessionLocal() as db:
        v = PlanVersion(plan_id=plan, label="alt", snapshot={"markers": [], "strokes": [
            {"id": "x", "phase_id": None, "layer_id": None, "kind": "freehand", "channel": "",
             "points": SQUARE, "color": -1, "width": -1, "extra_phase_ids": []},
        ]})
        db.add(v)
        db.commit()
        vid = v.id
    assert ed.post(f"/plans/{plan}/restore/{vid}").status_code == 200
    rs = list(_snap_strokes(ed, plan).values())
    assert [(x["closed"], x["name"], x["sidc"], x["fill"]) for x in rs] == [(False, "", "", True)]


def test_public_share_has_fields(world):
    w = world
    ed, plan = w["ed"], w["plan"]
    s = _commit(ed, plan, closed=True, name="Objekt", sidc=SIDC20)
    tok = ed.post(f"/plans/{plan}/shares", json={"label": "t"}).json()["token"]
    with TestClient(app) as anon:
        r = anon.get(f"/public/plans/{tok}")
        assert r.status_code == 200
        ps = {x["id"]: x for x in r.json()["strokes"]}[s["id"]]
        assert (ps["closed"], ps["name"], ps["sidc"], ps["fill"]) == (True, "Objekt", SIDC20, True)


def test_live_broadcast_contains_fields(world):
    w = world
    with w["ed"].websocket_connect(f"/plans/{w['plan']}/live") as ws:
        _skip_hello(ws)
        ws.send_json({"type": "stroke.commit", "cid": "c", "data": {"points": SQUARE, "closed": True, "name": "N"}})
        msg = ws.receive_json()
        assert msg["stroke"]["closed"] is True and msg["stroke"]["name"] == "N"
