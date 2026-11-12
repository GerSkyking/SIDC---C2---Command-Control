"""Punkt-Werkzeug: Stroke kind "dot" mit genau 1 Punkt, Farbe/Größe (width) und Text (name)."""
import itertools

import pytest
from fastapi.testclient import TestClient

from app.main import app
from tests.test_plan_refs import _ws
from tests.test_project_tools import _map, _user

_n = itertools.count(1)  # eigener Präfix "sd" (Benutzernamen kollidieren sonst)


@pytest.fixture
def world(admin):
    k = next(_n)
    ed, _ = _user(admin, f"sd{k}a", can_create_plans=True)
    _map(admin)
    plan = ed.post("/plans", json={"name": "Punkte", "map_id": "m1"}).json()["id"]
    return dict(admin=admin, ed=ed, plan=plan)


def _dot(c, plan, **data):
    data.setdefault("kind", "dot")
    data.setdefault("points", [[0.005, 0.005]])
    return _ws(c, plan, type="stroke.commit", cid="d", data=data)


def test_create_dot(world):
    w = world
    msg = _dot(w["ed"], w["plan"], color=-16776961, width=8, name="  Sammel   punkt  ", closed=True)
    assert msg["type"] == "stroke.upsert", msg
    s = msg["stroke"]
    assert s["kind"] == "dot" and s["points"] == [[0.005, 0.005]]
    assert s["color"] == -16776961 and s["width"] == 8 and s["name"] == "Sammel punkt"
    assert s["closed"] is False  # ein Punkt ist nie eine Fläche


def test_dot_needs_exactly_one_point(world):
    w = world
    for pts in ([], [[0, 0], [1, 1]], [[0, 0], [1, 1], [1, 0]]):
        msg = _dot(w["ed"], w["plan"], points=pts)
        assert msg["type"] != "stroke.upsert", msg
    snap = w["ed"].get(f"/plans/{w['plan']}/snapshot").json()["strokes"]
    assert snap == []


def test_move_and_modify_dot(world):
    w = world
    s = _dot(w["ed"], w["plan"], name="A")["stroke"]
    # Verschieben: genau 1 Punkt wird übernommen
    st = _ws(w["ed"], w["plan"], type="stroke.modify", id=s["id"], data={"points": [[0.01, 0.02]]})["stroke"]
    assert st["points"] == [[0.01, 0.02]]
    # Mehrere Punkte werden für einen Punkt ignoriert
    st = _ws(w["ed"], w["plan"], type="stroke.modify", id=s["id"], data={"points": [[0, 0], [1, 1]]})["stroke"]
    assert st["points"] == [[0.01, 0.02]]
    # Farbe/Größe/Text ändern, Schließen bleibt wirkungslos
    st = _ws(w["ed"], w["plan"], type="stroke.modify", id=s["id"],
             data={"color": -65536, "width": 12, "name": "B", "closed": True})["stroke"]
    assert (st["color"], st["width"], st["name"], st["closed"], st["kind"]) == (-65536, 12, "B", False, "dot")


def test_line_still_needs_two_points_on_modify(world):
    w = world
    s = _ws(w["ed"], w["plan"], type="stroke.commit", cid="l",
            data={"kind": "phaseline", "points": [[0, 0], [1, 1]]})["stroke"]
    st = _ws(w["ed"], w["plan"], type="stroke.modify", id=s["id"], data={"points": [[5, 5]]})["stroke"]
    assert st["points"] == [[0, 0], [1, 1]]


def test_public_share_has_dot(world):
    w = world
    s = _dot(w["ed"], w["plan"], name="Treffpunkt")["stroke"]
    tok = w["ed"].post(f"/plans/{w['plan']}/shares", json={"label": "t"}).json()["token"]
    with TestClient(app) as anon:
        ps = {x["id"]: x for x in anon.get(f"/public/plans/{tok}").json()["strokes"]}[s["id"]]
        assert (ps["kind"], ps["name"], len(ps["points"])) == ("dot", "Treffpunkt", 1)
