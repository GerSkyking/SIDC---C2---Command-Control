"""Lineal: gespeicherte Messlinie = Stroke kind "measure" (Linie, nie geschlossen), landet im Snapshot."""
import itertools

import pytest

from tests.test_plan_refs import _ws
from tests.test_project_tools import _map, _user

_n = itertools.count(1)


@pytest.fixture
def world(admin):
    k = next(_n)
    ed, _ = _user(admin, f"sm{k}a", can_create_plans=True)
    _map(admin)
    plan = ed.post("/plans", json={"name": "Lineal", "map_id": "m1"}).json()["id"]
    return dict(ed=ed, plan=plan)


def test_measure_is_persisted_open_line(world):
    w = world
    pts = [[0.0, 0.0], [0.01, 0.0], [0.01, 0.01], [0.0, 0.0]]
    msg = _ws(w["ed"], w["plan"], type="stroke.commit", cid="m",
              data={"kind": "measure", "points": pts, "color": -1, "width": 2, "closed": True})
    assert msg["type"] == "stroke.upsert", msg
    s = msg["stroke"]
    assert s["kind"] == "measure" and s["closed"] is False
    st = _ws(w["ed"], w["plan"], type="stroke.modify", id=s["id"], data={"closed": True})["stroke"]
    assert st["closed"] is False
    snap = w["ed"].get(f"/plans/{w['plan']}/snapshot").json()["strokes"]
    assert [x["kind"] for x in snap] == ["measure"]
