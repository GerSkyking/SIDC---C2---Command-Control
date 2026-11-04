"""Missionsbau-Werkzeuge Phase 3: Annotationen (Referenz-Pins) als Rückverweis-Quelle."""
import itertools

import pytest

from tests.test_live_hardening import _skip_hello
from tests.test_project_tools import _back, _doc, _map, _user

_n = itertools.count(1)  # eigener Zähler: das Test-Modul wird je nach Import-Pfad doppelt geladen (Benutzernamen kollidieren sonst)


@pytest.fixture
def world(admin):
    """builder (Missionsbauer, Plan-Owner), ed (Projekt-Editor), vw (Viewer)."""
    k = next(_n)
    builder, bid = _user(admin, f"pr{k}a", is_mission_builder=True, can_create_plans=True)
    ed, eid = _user(admin, f"pr{k}b")
    vw, vid = _user(admin, f"pr{k}c")
    pid = builder.post("/projects", json={"name": "Op Refs"}).json()["id"]
    r = builder.put(f"/projects/{pid}/members", json=[
        {"subject_type": "user", "subject_id": bid, "role": "owner"},
        {"subject_type": "user", "subject_id": eid, "role": "editor"},
        {"subject_type": "user", "subject_id": vid, "role": "viewer"},
    ])
    assert r.status_code == 200, r.text
    return dict(admin=admin, builder=builder, ed=ed, vw=vw, pid=pid, eid=eid, vid=vid)


def _ws_ann(c, plan_id, **data):
    """Annotation per WebSocket anlegen; liefert die Annotation."""
    with c.websocket_connect(f"/plans/{plan_id}/live") as ws:
        _skip_hello(ws)
        ws.send_json({"type": "annotation.create", "cid": "a", "data": data})
        msg = ws.receive_json()
        assert msg["type"] == "annotation.upsert", msg
        return msg["annotation"]


def _ws(c, plan_id, **msg):
    with c.websocket_connect(f"/plans/{plan_id}/live") as ws:
        _skip_hello(ws)
        ws.send_json(msg)
        return ws.receive_json()


def _acl_plus(owner, plan_id, uid):
    cur = owner.get(f"/plans/{plan_id}/acl").json()
    acl = [{"subject_type": e["subject_type"], "subject_id": e["subject_id"], "level": e["level"]} for e in cur]
    acl.append({"subject_type": "user", "subject_id": uid, "level": "viewer"})
    return acl


def _setup(w):
    _map(w["admin"])
    doc = _doc(w["ed"], w["pid"], "Ziel")
    plan = w["builder"].post("/plans", json={"name": "Alpha", "map_id": "m1", "project_id": w["pid"]}).json()
    return doc, plan


def test_backlink_lifecycle(world):
    w = world
    b, pid = w["builder"], w["pid"]
    doc, plan = _setup(w)
    code = "{{doc:%s}}" % doc["id"]
    a = _ws_ann(b, plan["id"], text="Siehe " + code, world_x=1, world_y=2)
    res = _back(b, pid, "doc", doc["id"])
    assert [(r["type"], r["label"], r["href"]) for r in res] == [("annotation", "Alpha (Karte)", f"#/plans/{plan['id']}")]
    # Verschieben ändert nichts, Text ohne Code entfernt den Verweis
    assert _ws(b, plan["id"], type="annotation.move", id=a["id"], data={"world_x": 5})["type"] == "annotation.upsert"
    assert len(_back(b, pid, "doc", doc["id"])) == 1
    assert _ws(b, plan["id"], type="annotation.modify", id=a["id"], data={"text": "leer"})["type"] == "annotation.upsert"
    assert _back(b, pid, "doc", doc["id"]) == []
    _ws(b, plan["id"], type="annotation.modify", id=a["id"], data={"text": code})
    assert len(_back(b, pid, "doc", doc["id"])) == 1
    # Löschen
    assert _ws(b, plan["id"], type="annotation.delete", id=a["id"])["type"] == "annotation.delete"
    assert _back(b, pid, "doc", doc["id"]) == []


def test_plan_without_project_has_no_index(world):
    w = world
    b = w["builder"]
    doc, _ = _setup(w)
    free = b.post("/plans", json={"name": "Frei", "map_id": "m1"}).json()
    _ws_ann(b, free["id"], text="{{doc:%s}}" % doc["id"])
    assert _back(b, w["pid"], "doc", doc["id"]) == []
    # In das Projekt verschieben -> Verweis erscheint, Herauslösen -> weg
    assert b.post(f"/plans/{free['id']}/project", json={"project_id": w["pid"]}).status_code == 200
    assert len(_back(b, w["pid"], "doc", doc["id"])) == 1
    assert b.post(f"/plans/{free['id']}/project", json={"project_id": None}).status_code == 200
    assert _back(b, w["pid"], "doc", doc["id"]) == []


def test_rights_plan_acl_and_builder_plane(world):
    w = world
    b, ed, vw, pid = w["builder"], w["ed"], w["vw"], w["pid"]
    doc, plan = _setup(w)
    code = "{{doc:%s}}" % doc["id"]
    bph = next(p for p in b.get(f"/plans/{plan['id']}/phases").json() if p["plane"] == "builder")
    pph = next(p for p in b.get(f"/plans/{plan['id']}/phases").json() if p["plane"] == "player")
    _ws_ann(b, plan["id"], text=code, phase_id=pph["id"])
    _ws_ann(b, plan["id"], text=code, phase_id=bph["id"])
    assert len(_back(b, pid, "doc", doc["id"])) == 2  # eine Zeile je Annotation
    # Projektmitglieder ohne Plan-ACL sehen keinen Rückverweis
    assert _back(ed, pid, "doc", doc["id"]) == []
    acl = _acl_plus(b, plan["id"], w["eid"])
    assert b.put(f"/plans/{plan['id']}/acl", json=acl).status_code == 200
    res = _back(ed, pid, "doc", doc["id"])
    assert len(res) == 1  # nur die Spieler-Annotation (Nicht-Missionsbauer)
    assert _back(vw, pid, "doc", doc["id"]) == []  # vw hat weiterhin keine Plan-ACL
    # Nur Builder-Annotation vorhanden -> Nicht-Builder sieht nichts
    plan2 = b.post("/plans", json={"name": "Beta", "map_id": "m1", "project_id": pid}).json()
    bph2 = next(p for p in b.get(f"/plans/{plan2['id']}/phases").json() if p["plane"] == "builder")
    _ws_ann(b, plan2["id"], text=code, phase_id=bph2["id"])
    acl2 = _acl_plus(b, plan2["id"], w["eid"])
    assert b.put(f"/plans/{plan2['id']}/acl", json=acl2).status_code == 200
    labels = [r["label"] for r in _back(ed, pid, "doc", doc["id"])]
    assert labels == ["Alpha (Karte)"]
    assert sorted(r["label"] for r in _back(b, pid, "doc", doc["id"])) == ["Alpha (Karte)", "Alpha (Karte)", "Beta (Karte)"]


def test_plan_delete_and_phase_delete(world):
    w = world
    b, pid = w["builder"], w["pid"]
    doc, plan = _setup(w)
    code = "{{doc:%s}}" % doc["id"]
    extra = b.post(f"/plans/{plan['id']}/phases", json={"name": "Zwei"}).json()
    bph = b.post(f"/plans/{plan['id']}/phases", json={"name": "B2", "plane": "builder", "parent_id": extra["id"]}).json()
    _ws_ann(b, plan["id"], text=code, phase_id=bph["id"])
    assert len(_back(b, pid, "doc", doc["id"])) == 1
    assert b.delete(f"/plans/{plan['id']}/phases/{extra['id']}").status_code == 200  # Missionsbau-Inhalte gehen mit
    assert _back(b, pid, "doc", doc["id"]) == []
    _ws_ann(b, plan["id"], text=code)
    assert len(_back(b, pid, "doc", doc["id"])) == 1
    # Papierkorb: Plan weg -> kein Rückverweis; wiederhergestellt -> wieder da
    assert b.delete(f"/plans/{plan['id']}").status_code in (200, 204)
    assert _back(b, pid, "doc", doc["id"]) == []
    assert b.post(f"/plans/{plan['id']}/undelete").status_code == 200
    assert len(_back(b, pid, "doc", doc["id"])) == 1
    # Endgültig löschen räumt den Index auf
    assert b.delete(f"/plans/{plan['id']}").status_code in (200, 204)
    assert b.delete(f"/plans/{plan['id']}/purge").status_code == 200
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import ProjectRef

    with SessionLocal() as db:
        assert not list(db.scalars(select(ProjectRef).where(ProjectRef.source_type == "annotation", ProjectRef.target_id == doc["id"])))


def test_ref_columns_fit_all_source_types():
    """SQLite prüft VARCHAR-Längen nicht, Postgres schon: „annotation“ passte einst nicht in String(8)."""
    from app.models import ProjectRef

    for col in ("source_type", "target_type"):
        length = ProjectRef.__table__.c[col].type.length
        for value in ("doc", "task", "note", "annotation", "plan", "img", "place"):
            assert len(value) <= length, (col, value, length)
