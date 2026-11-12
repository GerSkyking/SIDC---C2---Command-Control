"""Layer "Missionsbau-Notizen" in Projekt-Plänen (Phase.role == "notes") + Liste "Auf der Karte"."""
import itertools

import pytest

from tests.test_live_hardening import _skip_hello
from tests.test_plan_refs import _acl_plus, _ws, _ws_ann
from tests.test_project_tools import _map, _user

_n = itertools.count(1)  # eigener Zähler / Präfix "mn" (Benutzernamen kollidieren sonst)


@pytest.fixture
def world(admin):
    """builder (Missionsbauer, Plan-Owner), zeus (Editor), ed (Editor, kein Missionsbauer), vw (Viewer),
    outsider (Missionsbauer ohne Plan-Zugriff)."""
    k = next(_n)
    builder, bid = _user(admin, f"mn{k}a", is_mission_builder=True, can_create_plans=True)
    zeus, zid = _user(admin, f"mn{k}b", is_zeus=True)
    ed, eid = _user(admin, f"mn{k}c")
    vw, vid = _user(admin, f"mn{k}d")
    out, oid = _user(admin, f"mn{k}e", is_mission_builder=True)
    pid = builder.post("/projects", json={"name": "Op Notes"}).json()["id"]
    r = builder.put(f"/projects/{pid}/members", json=[
        {"subject_type": "user", "subject_id": bid, "role": "owner"},
        {"subject_type": "user", "subject_id": zid, "role": "editor"},
        {"subject_type": "user", "subject_id": eid, "role": "editor"},
        {"subject_type": "user", "subject_id": vid, "role": "viewer"},
        {"subject_type": "user", "subject_id": oid, "role": "viewer"},
    ])
    assert r.status_code == 200, r.text
    _map(admin)
    plan = builder.post("/plans", json={"name": "Alpha", "map_id": "m1", "project_id": pid}).json()["id"]
    acl = [{"subject_type": "user", "subject_id": bid, "level": "owner"}]
    for uid, lvl in ((zid, "editor"), (eid, "editor"), (vid, "viewer")):
        acl.append({"subject_type": "user", "subject_id": uid, "level": lvl})
    assert builder.put(f"/plans/{plan}/acl", json=acl).status_code == 200
    return dict(admin=admin, builder=builder, zeus=zeus, ed=ed, vw=vw, out=out, pid=pid, plan=plan)


def _notes(c, plan):
    ph = [p for p in c.get(f"/plans/{plan}/phases").json() if p.get("role") == "notes"]
    return ph


def _snap_ann_ids(c, plan):
    return {a["id"] for a in c.get(f"/plans/{plan}/snapshot").json()["annotations"]}


def test_notes_phase_created_with_plan(world):
    w = world
    ph = _notes(w["builder"], w["plan"])
    assert len(ph) == 1
    p = ph[0]
    assert p["plane"] == "builder" and p["name"] == "Missionsbau-Notizen"
    assert p["zeus_released"] is False and p["zeus_until"] is None and p["player_released"] is False
    assert p["parent_id"] is None
    # Plan ohne Projekt: keine notes-Phase
    free = w["builder"].post("/plans", json={"name": "Frei", "map_id": "m1"}).json()["id"]
    assert _notes(w["builder"], free) == []


def test_notes_phase_on_move_into_project_idempotent(world):
    w = world
    free = w["builder"].post("/plans", json={"name": "Frei", "map_id": "m1"}).json()["id"]
    assert w["builder"].post(f"/plans/{free}/project", json={"project_id": w["pid"]}).status_code == 200
    assert len(_notes(w["builder"], free)) == 1
    assert w["builder"].post(f"/plans/{free}/project", json={"project_id": w["pid"]}).status_code == 200
    assert len(_notes(w["builder"], free)) == 1
    # Herauslösen: Rolle entfällt, Phase wäre dann normal löschbar
    assert w["builder"].post(f"/plans/{free}/project", json={"project_id": None}).status_code == 200
    assert _notes(w["builder"], free) == []


def test_clone_into_project_has_notes_phase(world):
    w = world
    folder = w["builder"].post("/folders", json={"name": "F", "project_id": w["pid"]}).json()["id"]
    c = w["builder"].post(f"/plans/{w['plan']}/clone", json={"name": "Klon", "folder_id": folder})
    assert c.status_code == 201, c.text
    assert len(_notes(w["builder"], c.json()["id"])) == 1
    # Nicht-Missionsbauer-Klon (Builder-Ebene wird übersprungen) bekommt trotzdem eine eigene notes-Ebene
    ed_plan = w["ed"].post(f"/plans/{w['plan']}/clone", json={"name": "Klon2", "folder_id": folder})
    if ed_plan.status_code == 201:  # nur wenn der Editor Pläne erstellen darf
        assert len(_notes(w["builder"], ed_plan.json()["id"])) == 1


def test_annotation_layer_is_explicit(world):
    w = world
    notes = _notes(w["builder"], w["plan"])[0]["id"]
    base = [p for p in w["builder"].get(f"/plans/{w['plan']}/phases").json() if p["plane"] == "player"][0]["id"]
    # mb_layer: auf den Layer (Client-Phasen werden ignoriert)
    a = _ws_ann(w["builder"], w["plan"], mb_layer=True, text="# Titel", phase_id=base, extra_phase_ids=[base])
    assert a["phase_id"] == notes and a["extra_phase_ids"] == []
    # ohne mb_layer: normale Notiz in der gewählten Phase
    b = _ws_ann(w["builder"], w["plan"], text="zwei", phase_id=base)
    assert b["phase_id"] == base
    # modify mit ausdrücklicher Phase (ohne mb_layer) setzt die Notiz in diese Phase
    msg = _ws(w["builder"], w["plan"], type="annotation.modify", id=a["id"], data={"width": 300, "phase_id": base})
    assert msg["annotation"]["phase_id"] == base  # ausdrückliche Phase = Wechsel auf normale Notiz
    with w["builder"].websocket_connect(f"/plans/{w['plan']}/live") as ws:
        _skip_hello(ws)
        ws.send_json({"type": "annotation.modify", "id": a["id"], "data": {"mb_layer": True}})
        # Wechsel auf den Layer: erst delete an alle (auch an mich), dann das upsert für den Missionsbau
        assert ws.receive_json() == {"type": "annotation.delete", "id": a["id"]}
        assert ws.receive_json()["annotation"]["phase_id"] == notes
    # mb_layer: false ohne Ziel-Phase lässt die Notiz, wo sie ist
    msg = _ws(w["builder"], w["plan"], type="annotation.modify", id=a["id"], data={"mb_layer": False, "phase_id": notes})
    assert msg["annotation"]["phase_id"] == notes
    msg = _ws(w["builder"], w["plan"], type="annotation.modify", id=a["id"], data={"mb_layer": False, "phase_id": base})
    assert msg["annotation"]["phase_id"] == base


def test_editor_gets_normal_notes_and_layer_switch_hides_live(world):
    w = world
    base = [p for p in w["builder"].get(f"/plans/{w['plan']}/phases").json() if p["plane"] == "player"][0]["id"]
    # Editor ohne Missionsbau: normale Notiz; mb_layer wird ignoriert
    e = _ws_ann(w["ed"], w["plan"], mb_layer=True, text="Spieler-Notiz", phase_id=base)
    assert e["phase_id"] == base
    assert e["id"] in _snap_ann_ids(w["vw"], w["plan"])
    # Missionsbau hebt sie auf den Layer: Spieler bekommen live ein delete
    with w["ed"].websocket_connect(f"/plans/{w['plan']}/live") as ews:
        _skip_hello(ews)
        with w["builder"].websocket_connect(f"/plans/{w['plan']}/live") as bws:
            _skip_hello(bws)
            assert ews.receive_json()["type"] == "presence.join"
            bws.send_json({"type": "annotation.modify", "id": e["id"], "data": {"mb_layer": True}})
            assert ews.receive_json() == {"type": "annotation.delete", "id": e["id"]}
    assert e["id"] not in _snap_ann_ids(w["vw"], w["plan"])
    # und der Editor darf sie jetzt nicht mehr ändern
    assert _ws(w["ed"], w["plan"], type="annotation.modify", id=e["id"], data={"text": "x"})["type"] == "reject"


def _rel(c, plan, aid, released, hours=None):
    data = {"zeus_released": released}
    if hours is not None:
        data["zeus_hours"] = hours
    return _ws(c, plan, type="annotation.modify", id=aid, data=data)


def test_zeus_sees_only_released_pins(world):
    w = world
    a = _ws_ann(w["builder"], w["plan"], mb_layer=True, text="geheim")
    b = _ws_ann(w["builder"], w["plan"], mb_layer=True, text="offen")
    assert a["zeus_released"] is False
    # Standard: Zeus sieht keine Notiz, auch keine Ebene
    assert _snap_ann_ids(w["zeus"], w["plan"]) & {a["id"], b["id"]} == set()
    assert _notes(w["zeus"], w["plan"]) == []
    # nur b freigeben (unbegrenzt)
    msg = _rel(w["builder"], w["plan"], b["id"], True)
    assert msg["annotation"]["zeus_released"] is True and msg["annotation"]["zeus_until"] is None
    ids = _snap_ann_ids(w["zeus"], w["plan"])
    assert b["id"] in ids and a["id"] not in ids
    # Zeus darf die Ebene weiterhin nicht freigeben und nichts ändern
    notes = _notes(w["builder"], w["plan"])[0]["id"]
    assert w["builder"].patch(f"/plans/{w['plan']}/phases/{notes}", json={"zeus_released": True}).status_code == 400
    assert _ws(w["zeus"], w["plan"], type="annotation.modify", id=b["id"], data={"text": "x"})["type"] == "reject"
    assert _ws(w["zeus"], w["plan"], type="annotation.modify", id=b["id"], data={"zeus_released": False})["type"] == "reject"
    assert _ws(w["zeus"], w["plan"], type="annotation.delete", id=b["id"])["type"] == "reject"
    # 72 h: befristet; abgelaufene Freigabe zählt nicht mehr
    msg = _rel(w["builder"], w["plan"], b["id"], True, 72)
    assert msg["annotation"]["zeus_until"] is not None and msg["annotation"]["zeus_released"] is True
    from datetime import timedelta

    from app.db import SessionLocal
    from app.models import Annotation, now

    with SessionLocal() as db:
        x = db.get(Annotation, b["id"])
        x.zeus_until = now() - timedelta(hours=1)
        db.commit()
    assert b["id"] not in _snap_ann_ids(w["zeus"], w["plan"])
    # Rücknahme
    _rel(w["builder"], w["plan"], b["id"], True)
    assert b["id"] in _snap_ann_ids(w["zeus"], w["plan"])
    _rel(w["builder"], w["plan"], b["id"], False)
    assert b["id"] not in _snap_ann_ids(w["zeus"], w["plan"])
    # Missionsbau sieht alle samt Zustand
    snap = {x["id"]: x for x in w["builder"].get(f"/plans/{w['plan']}/snapshot").json()["annotations"]}
    assert snap[a["id"]]["zeus_released"] is False and snap[b["id"]]["zeus_released"] is False


def test_zeus_live_follows_pin_release(world):
    w = world
    a = _ws_ann(w["builder"], w["plan"], mb_layer=True, text="live")
    with w["zeus"].websocket_connect(f"/plans/{w['plan']}/live") as zws:
        _skip_hello(zws)
        with w["builder"].websocket_connect(f"/plans/{w['plan']}/live") as bws:
            _skip_hello(bws)
            assert zws.receive_json()["type"] == "presence.join"
            # unfreigegebene Änderung: Zeus bekommt nichts
            bws.send_json({"type": "annotation.modify", "id": a["id"], "data": {"text": "still"}})
            assert bws.receive_json()["type"] == "annotation.upsert"
            # Freigabe: Zeus bekommt die Notiz
            bws.send_json({"type": "annotation.modify", "id": a["id"], "data": {"zeus_released": True}})
            assert bws.receive_json()["annotation"]["zeus_released"] is True
            m = zws.receive_json()
            assert m["type"] == "annotation.upsert" and m["annotation"]["id"] == a["id"]
            assert m["annotation"]["text"] == "still"
            # Rücknahme: Zeus bekommt ein delete, der Missionsbau ein upsert
            bws.send_json({"type": "annotation.modify", "id": a["id"], "data": {"zeus_released": False}})
            assert bws.receive_json()["type"] == "annotation.upsert"
            assert zws.receive_json() == {"type": "annotation.delete", "id": a["id"]}
            # wieder freigeben und löschen: Zeus bekommt das delete
            bws.send_json({"type": "annotation.modify", "id": a["id"], "data": {"zeus_released": True}})
            bws.receive_json()
            assert zws.receive_json()["type"] == "annotation.upsert"
            bws.send_json({"type": "annotation.delete", "id": a["id"]})
            assert bws.receive_json()["type"] == "annotation.delete"
            assert zws.receive_json() == {"type": "annotation.delete", "id": a["id"]}


def test_players_never_see_notes(world):
    w = world
    a = _ws_ann(w["builder"], w["plan"], mb_layer=True, text="intern")
    _rel(w["builder"], w["plan"], a["id"], True)  # nur Zeus
    for who in ("ed", "vw"):
        assert a["id"] not in _snap_ann_ids(w[who], w["plan"])
        assert _notes(w[who], w["plan"]) == []
    # Editor ohne Missionsbau darf die Layer-Notiz nicht freigeben
    assert _ws(w["ed"], w["plan"], type="annotation.modify", id=a["id"], data={"zeus_released": False})["type"] == "reject"
    # Viewer darf nichts anlegen
    msg = _ws(w["vw"], w["plan"], type="annotation.create", cid="v", data={"text": "x"})
    assert msg["type"] == "reject"
    # Live-Broadcast erreicht Spieler nicht
    with w["ed"].websocket_connect(f"/plans/{w['plan']}/live") as ews:
        _skip_hello(ews)
        with w["builder"].websocket_connect(f"/plans/{w['plan']}/live") as bws:
            _skip_hello(bws)
            ews.receive_json()  # presence.join
            bws.send_json({"type": "annotation.modify", "id": a["id"], "data": {"text": "neu"}})
            assert bws.receive_json()["type"] == "annotation.upsert"
        assert ews.receive_json()["type"] == "presence.leave"  # kein annotation.upsert dazwischen


def test_notes_phase_protected(world):
    w = world
    notes = _notes(w["builder"], w["plan"])[0]["id"]
    r = w["builder"].delete(f"/plans/{w['plan']}/phases/{notes}")
    assert r.status_code == 400 and "Missionsbau-Notizen" in r.json()["detail"]
    # Rolle nicht per API änderbar, Umbenennen erlaubt
    r = w["builder"].patch(f"/plans/{w['plan']}/phases/{notes}", json={"name": "Kartenzettel", "role": None})
    assert r.status_code == 200 and r.json()["role"] == "notes" and r.json()["name"] == "Kartenzettel"


def test_map_notes_endpoint(world):
    w = world
    _ws_ann(w["builder"], w["plan"], mb_layer=True, text="## Zweiter\nrest", world_x=5, world_y=6)
    a = _ws_ann(w["builder"], w["plan"], mb_layer=True, text="\n\n# Erster Titel\nrest")
    r = w["builder"].get(f"/projects/{w['pid']}/map-notes")
    assert r.status_code == 200, r.text
    rows = r.json()
    assert len(rows) == 2 and all(x["mb"] for x in rows)
    row = next(x for x in rows if x["id"] == a["id"])
    assert row["title"] == "Erster Titel" and row["plan_name"] == "Alpha" and row["plan_id"] == w["plan"]
    assert row["href"] == f"#/plans/{w['plan']}" and row["updated_at"].endswith("Z")
    assert row["updated_by_label"]
    assert row["zeus_released"] is False and row["zeus_until"] is None
    assert rows[0]["updated_at"] >= rows[1]["updated_at"]
    # Nicht-Missionsbauer: 404; Missionsbauer ohne Plan-Zugriff: Plan fehlt
    assert w["ed"].get(f"/projects/{w['pid']}/map-notes").status_code == 404
    assert w["vw"].get(f"/projects/{w['pid']}/map-notes").status_code == 404
    assert w["out"].get(f"/projects/{w['pid']}/map-notes").json() == []


def test_plan_without_project_unchanged(world):
    w = world
    free = w["builder"].post("/plans", json={"name": "Frei", "map_id": "m1"}).json()["id"]
    base = [p for p in w["builder"].get(f"/plans/{free}/phases").json() if p["plane"] == "player"][0]["id"]
    a = _ws_ann(w["builder"], free, text="x")
    assert a["phase_id"] == base
    assert _notes(w["builder"], free) == []


def test_migration_values_fit_columns():
    from app.models import Phase
    from app.services.notes_layer import NOTES_NAME, NOTES_ROLE

    assert len(NOTES_ROLE) <= Phase.__table__.c.role.type.length
    assert len(NOTES_NAME) <= Phase.__table__.c.name.type.length
    assert len("0044_annotation_zeus") <= 32  # alembic_version.version_num


def test_existing_annotation_keeps_its_phase_on_resize(world):
    """Der Client schickt beim Skalieren/Verschieben die phase_id mit; Altbestand darf nicht auf die Ebene springen."""
    from app.db import SessionLocal
    from app.models import Annotation

    w = world
    base = [p for p in w["builder"].get(f"/plans/{w['plan']}/phases").json() if p["plane"] == "player"][0]["id"]
    with SessionLocal() as db:
        a = Annotation(plan_id=w["plan"], phase_id=base, world_x=0, world_y=0, text="alt", width=200)
        db.add(a)
        db.commit()
        aid = a.id
    msg = _ws(w["builder"], w["plan"], type="annotation.modify", id=aid, data={"width": 300, "phase_id": base})
    assert msg["annotation"]["width"] == 300 and msg["annotation"]["phase_id"] == base
    msg = _ws(w["builder"], w["plan"], type="annotation.move", id=aid, data={"world_x": 3, "phase_id": base, "extra_phase_ids": []})
    assert msg["annotation"]["world_x"] == 3 and msg["annotation"]["phase_id"] == base


def test_annotation_area(world):
    """Bereich um einen Pin: bereinigt gespeichert, im Snapshot, wandert per move mit, null entfernt ihn."""
    w = world
    pts = [[0, 0], [1, 0], [1, 1], ["x", 2], [5]]
    a = _ws_ann(w["builder"], w["plan"], mb_layer=True, text="Ort", area={"pts": pts, "closed": True})
    assert a["area"] == {"pts": [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 2.0]], "closed": True}
    # weniger als 3 Punkte: nie geschlossen; weniger als 2: kein Bereich
    msg = _ws(w["builder"], w["plan"], type="annotation.modify", id=a["id"], data={"area": {"pts": [[0, 0], [2, 2]], "closed": True}})
    assert msg["annotation"]["area"] == {"pts": [[0.0, 0.0], [2.0, 2.0]], "closed": False}
    msg = _ws(w["builder"], w["plan"], type="annotation.modify", id=a["id"], data={"area": {"pts": [[0, 0]]}})
    assert msg["annotation"]["area"] is None
    # move nimmt den verschobenen Bereich mit
    area = {"pts": [[3, 3], [4, 3], [4, 4]], "closed": True}
    msg = _ws(w["builder"], w["plan"], type="annotation.move", id=a["id"], data={"world_x": 3, "world_y": 3, "area": area})
    assert msg["annotation"]["area"] == {"pts": [[3.0, 3.0], [4.0, 3.0], [4.0, 4.0]], "closed": True}
    snap = {x["id"]: x for x in w["builder"].get(f"/plans/{w['plan']}/snapshot").json()["annotations"]}
    assert snap[a["id"]]["area"]["closed"] is True
    # höchstens 200 Punkte
    big = {"pts": [[i, i] for i in range(500)], "closed": False}
    msg = _ws(w["builder"], w["plan"], type="annotation.modify", id=a["id"], data={"area": big})
    assert len(msg["annotation"]["area"]["pts"]) == 200
    msg = _ws(w["builder"], w["plan"], type="annotation.modify", id=a["id"], data={"area": None})
    assert msg["annotation"]["area"] is None
