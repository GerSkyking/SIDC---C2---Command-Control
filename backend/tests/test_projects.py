"""Missionsbau-Projekte: Rechte, Missionsbau-Bereich, Dateien, Aufgaben, Pläne, Bilder, Speicher."""
import base64
import itertools

import pytest
from fastapi.testclient import TestClient

from app.main import app

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg=="
)
PW = "pw-1234567890"
_n = itertools.count(1)


def _user(admin, name, **flags):
    r = admin.post("/api/admin/users", json={"username": name, "password": PW, "role": "user", **flags})
    assert r.status_code == 201, r.text
    c = TestClient(app)
    assert c.post("/auth/login", json={"username": name, "password": PW}).status_code == 200
    return c, r.json()["id"]


def _names():
    k = next(_n)
    return f"u{k}a", f"u{k}b", f"u{k}c"


def _map(admin):
    admin.post("/api/maps", json={"id": "m1", "name": "M1", "url": "http://x.invalid/a.zip"})
    from app.db import SessionLocal
    from app.models import Map, now

    with SessionLocal() as db:
        m = db.get(Map, "m1")
        if m is not None:
            m.status = "ready"
            m.imported_at = now()
            db.commit()


@pytest.fixture
def world(admin):
    """builder (Missionsbauer, owner), ed (editor, kein Builder), vw (viewer), out (Außenstehender)."""
    a, b, c = _names()
    builder, bid = _user(admin, a, is_mission_builder=True, can_create_plans=True)
    ed, eid = _user(admin, b)
    vw, vid = _user(admin, c)
    out, oid = _user(admin, a + "x")
    pid = builder.post("/projects", json={"name": "Op Test"}).json()["id"]
    r = builder.put(f"/projects/{pid}/members", json=[
        {"subject_type": "user", "subject_id": bid, "role": "owner"},
        {"subject_type": "user", "subject_id": eid, "role": "editor"},
        {"subject_type": "user", "subject_id": vid, "role": "viewer"},
    ])
    assert r.status_code == 200, r.text
    return dict(admin=admin, builder=builder, ed=ed, vw=vw, out=out, pid=pid, bid=bid, eid=eid, vid=vid, oid=oid)


def test_create_and_visibility(world):
    w = world
    pid = w["pid"]
    non_builder, _ = _user(w["admin"], _names()[0] + "n")
    assert non_builder.post("/projects", json={"name": "x"}).status_code == 403
    assert w["out"].get(f"/projects/{pid}").status_code == 404
    assert all(p["id"] != pid for p in w["out"].get("/projects").json())
    assert w["vw"].get(f"/projects/{pid}").json()["role"] == "viewer"
    assert w["admin"].get(f"/projects/{pid}").json()["role"] == "owner"
    assert any(p["id"] == pid for p in w["ed"].get("/projects").json())
    # nur owner ändert
    assert w["ed"].patch(f"/projects/{pid}", json={"name": "neu"}).status_code == 403
    assert w["builder"].patch(f"/projects/{pid}", json={"name": "neu"}).json()["name"] == "neu"
    assert w["builder"].get(f"/projects/{pid}").json()["is_builder"] is True
    assert w["ed"].get(f"/projects/{pid}").json()["is_builder"] is False


def test_members_validation(world):
    w = world
    pid = w["pid"]
    assert w["ed"].put(f"/projects/{pid}/members", json=[]).status_code == 403
    # kein owner -> 400
    r = w["builder"].put(f"/projects/{pid}/members", json=[
        {"subject_type": "user", "subject_id": w["eid"], "role": "editor"}])
    assert r.status_code == 400
    # unbekannte Rolle -> 422
    r = w["builder"].put(f"/projects/{pid}/members", json=[
        {"subject_type": "user", "subject_id": w["bid"], "role": "god"}])
    assert r.status_code == 422
    # unbekannter Nutzer
    r = w["builder"].put(f"/projects/{pid}/members", json=[
        {"subject_type": "user", "subject_id": w["bid"], "role": "owner"},
        {"subject_type": "user", "subject_id": "0" * 32, "role": "viewer"}])
    assert r.status_code == 400
    assert w["builder"].get(f"/projects/{pid}/members/candidates").status_code == 200
    assert w["vw"].get(f"/projects/{pid}/members/candidates").status_code == 403


def test_builder_space_hidden_and_roles(world):
    w = world
    pid = w["pid"]
    d = w["builder"].post(f"/projects/{pid}/docs", json={"space": "builder", "kind": "doc", "name": "Geheim", "content": "x"})
    assert d.status_code == 201
    bd = d.json()["id"]
    pd = w["ed"].post(f"/projects/{pid}/docs", json={"space": "public", "kind": "doc", "name": "Pub", "content": "hi"})
    assert pd.status_code == 201
    pub = pd.json()["id"]
    # Nicht-Builder: 404 auf alles im Missionsbau-Bereich
    assert w["ed"].get(f"/projects/{pid}/docs", params={"space": "builder"}).status_code == 404
    assert w["ed"].get(f"/projects/{pid}/docs/{bd}").status_code == 404
    assert w["ed"].patch(f"/projects/{pid}/docs/{bd}", json={"name": "x"}).status_code == 404
    assert w["ed"].delete(f"/projects/{pid}/docs/{bd}").status_code == 404
    assert w["ed"].post(f"/projects/{pid}/docs", json={"space": "builder", "kind": "doc", "name": "y"}).status_code == 404
    assert w["ed"].get(f"/projects/{pid}/images", params={"space": "builder"}).status_code == 404
    # public-Liste enthält das Geheimdokument nicht
    assert [x["id"] for x in w["ed"].get(f"/projects/{pid}/docs", params={"space": "public"}).json()] == [pub]
    assert len(w["builder"].get(f"/projects/{pid}/docs", params={"space": "builder"}).json()) == 1
    # viewer liest, schreibt nicht
    assert w["vw"].get(f"/projects/{pid}/docs/{pub}").json()["content"] == "hi"
    assert w["vw"].patch(f"/projects/{pid}/docs/{pub}", json={"content": "z"}).status_code == 403
    assert w["vw"].post(f"/projects/{pid}/docs", json={"space": "public", "kind": "doc", "name": "n"}).status_code == 403
    # Außenstehender: 404
    assert w["out"].get(f"/projects/{pid}/docs").status_code == 404
    # Overview blendet Builder-Dokumente für Nicht-Builder aus
    ov = w["ed"].get(f"/projects/{pid}/overview").json()
    assert [x["id"] for x in ov["recent_docs"]] == [pub]
    assert w["builder"].get(f"/projects/{pid}/overview").json()["counts"]["docs"] == 2


def test_doc_conflict_cycle_and_scope(world):
    w = world
    pid = w["pid"]
    c = w["builder"]
    f1 = c.post(f"/projects/{pid}/docs", json={"space": "public", "kind": "folder", "name": "A"}).json()
    f2 = c.post(f"/projects/{pid}/docs", json={"space": "public", "kind": "folder", "name": "B", "parent_id": f1["id"]}).json()
    # Zyklus: A in B verschieben
    assert c.patch(f"/projects/{pid}/docs/{f1['id']}", json={"parent_id": f2["id"]}).status_code == 400
    assert c.patch(f"/projects/{pid}/docs/{f1['id']}", json={"parent_id": f1["id"]}).status_code == 400
    # anderer Bereich -> 404
    fb = c.post(f"/projects/{pid}/docs", json={"space": "builder", "kind": "folder", "name": "BF"}).json()
    doc = c.post(f"/projects/{pid}/docs", json={"space": "public", "kind": "doc", "name": "D", "content": "v1"}).json()
    assert c.patch(f"/projects/{pid}/docs/{doc['id']}", json={"parent_id": fb["id"]}).status_code == 404
    # Doc als Parent -> 404
    assert c.post(f"/projects/{pid}/docs", json={"space": "public", "kind": "doc", "name": "x", "parent_id": doc["id"]}).status_code == 404
    # Konflikt
    ok = c.patch(f"/projects/{pid}/docs/{doc['id']}", json={"content": "v2", "expected_updated_at": doc["updated_at"]})
    assert ok.status_code == 200, ok.text
    stale = c.patch(f"/projects/{pid}/docs/{doc['id']}", json={"content": "v3", "expected_updated_at": doc["updated_at"]})
    assert stale.status_code == 409
    assert c.get(f"/projects/{pid}/docs/{doc['id']}").json()["content"] == "v2"
    # Verschieben + rekursives Löschen
    assert c.patch(f"/projects/{pid}/docs/{doc['id']}", json={"parent_id": f2["id"]}).status_code == 200
    assert c.delete(f"/projects/{pid}/docs/{f1['id']}").status_code == 200
    assert c.get(f"/projects/{pid}/docs/{doc['id']}").status_code == 404
    # Länge
    big = "x" * 200001
    assert c.post(f"/projects/{pid}/docs", json={"space": "public", "kind": "doc", "name": "big", "content": big}).status_code == 422
    # Dokument eines anderen Projekts nicht erreichbar
    p2 = c.post("/projects", json={"name": "P2"}).json()["id"]
    d2 = c.post(f"/projects/{p2}/docs", json={"space": "public", "kind": "doc", "name": "o"}).json()
    assert c.get(f"/projects/{pid}/docs/{d2['id']}").status_code == 404


def test_tasks_and_refs(world):
    w = world
    pid = w["pid"]
    ed = w["ed"]
    t = ed.post(f"/projects/{pid}/tasks", json={"title": "Eins", "assignee_id": w["eid"], "due_date": "2000-01-01"})
    assert t.status_code == 201, t.text
    tid = t.json()["id"]
    assert t.json()["assignee_label"]
    # Außenstehender als Zuständiger -> 400
    assert ed.post(f"/projects/{pid}/tasks", json={"title": "x", "assignee_id": w["oid"]}).status_code == 400
    # Fremdes Dokument/Plan -> 400
    p2 = w["builder"].post("/projects", json={"name": "P2"}).json()["id"]
    d2 = w["builder"].post(f"/projects/{p2}/docs", json={"space": "public", "kind": "doc", "name": "o"}).json()
    assert ed.post(f"/projects/{pid}/tasks", json={"title": "x", "doc_id": d2["id"]}).status_code == 400
    # Builder-Dokument: Nicht-Builder darf nicht referenzieren, Titel bleibt verborgen
    bd = w["builder"].post(f"/projects/{pid}/docs", json={"space": "builder", "kind": "doc", "name": "Geheim"}).json()
    assert ed.post(f"/projects/{pid}/tasks", json={"title": "x", "doc_id": bd["id"]}).status_code == 400
    bt = w["builder"].post(f"/projects/{pid}/tasks", json={"title": "mit Bezug", "doc_id": bd["id"]}).json()
    assert bt["doc_name"] == "Geheim"
    seen = next(x for x in ed.get(f"/projects/{pid}/tasks").json() if x["id"] == bt["id"])
    assert seen["doc_name"] is None and seen["doc_id"] == bd["id"]
    # Filter
    assert [x["id"] for x in ed.get(f"/projects/{pid}/tasks", params={"assignee": "me"}).json()] == [tid]
    # Verschieben + done_at
    mv = ed.post(f"/projects/{pid}/tasks/{tid}/move", json={"status": "done", "ordering": 0})
    assert mv.json()["status"] == "done" and mv.json()["done_at"]
    assert ed.get(f"/projects/{pid}/tasks", params={"status": "bogus"}).status_code == 422
    # Viewer liest nur
    assert w["vw"].get(f"/projects/{pid}/tasks").status_code == 200
    assert w["vw"].post(f"/projects/{pid}/tasks", json={"title": "x"}).status_code == 403
    assert w["vw"].delete(f"/projects/{pid}/tasks/{tid}").status_code == 403
    # Übersicht
    ov = ed.get(f"/projects/{pid}/overview").json()
    assert ov["counts"]["tasks_open"] >= 1
    assert ed.delete(f"/projects/{pid}/tasks/{tid}").status_code == 200


def test_notes(world):
    w = world
    pid = w["pid"]
    n = w["ed"].post(f"/projects/{pid}/notes", json={"text": "hi", "color": "pink", "x": 10, "y": 20}).json()
    assert n["color"] == "pink" and n["w"] == 220
    assert w["ed"].post(f"/projects/{pid}/notes", json={"color": "neon"}).status_code == 422
    assert w["ed"].post(f"/projects/{pid}/notes", json={"text": "x" * 4001}).status_code == 422
    assert w["ed"].patch(f"/projects/{pid}/notes/{n['id']}", json={"x": 55, "text": "neu"}).json()["x"] == 55
    assert w["vw"].patch(f"/projects/{pid}/notes/{n['id']}", json={"x": 1}).status_code == 403
    assert len(w["vw"].get(f"/projects/{pid}/notes").json()) == 1
    assert w["ed"].delete(f"/projects/{pid}/notes/{n['id']}").status_code == 200


def test_plans_no_implicit_rights_and_scope(world):
    w = world
    pid = w["pid"]
    _map(w["admin"])
    r = w["ed"].post("/plans", json={"name": "Projektplan", "map_id": "m1", "project_id": pid})
    assert r.status_code == 201, r.text
    plan = r.json()
    assert plan["project_id"] == pid
    # viewer: kein project_id-Schreiben; KEINE implizite Plan-Ebene -> Plan nicht sichtbar
    assert w["vw"].post("/plans", json={"name": "N", "map_id": "m1", "project_id": pid}).status_code == 403
    assert w["vw"].get(f"/plans/{plan['id']}").status_code == 403
    assert w["vw"].patch(f"/plans/{plan['id']}", json={"name": "z"}).status_code == 403
    assert w["vw"].get(f"/projects/{pid}/plans").json() == []
    assert w["vw"].get("/plans", params={"project_id": pid}).json() == []
    # Projekt-Owner/-Editor ohne Plan-ACL ebenfalls nicht (Owner = Builder ist hier nicht Plan-Ersteller)
    assert w["builder"].get(f"/plans/{plan['id']}").status_code == 403
    assert w["builder"].get(f"/projects/{pid}/plans").json() == []
    lst = {p["id"]: p for p in w["builder"].get("/projects").json()}
    assert lst[pid]["plan_count"] == 0
    assert {p["id"]: p for p in w["ed"].get("/projects").json()}[pid]["plan_count"] == 1
    assert {p["id"]: p for p in w["admin"].get("/projects").json()}[pid]["plan_count"] == 1
    assert w["builder"].get(f"/projects/{pid}/overview").json()["counts"]["plans"] == 0
    # Plan-ACL fuer die Gruppe/den Nutzer schaltet den Zugriff frei
    acl = w["ed"].get(f"/plans/{plan['id']}/acl")
    assert acl.status_code == 200, acl.text
    r = w["ed"].put(f"/plans/{plan['id']}/acl", json=[
        {"subject_type": "user", "subject_id": w["eid"], "level": "owner"},
        {"subject_type": "user", "subject_id": w["vid"], "level": "viewer"},
    ])
    assert r.status_code == 200, r.text
    assert w["vw"].get(f"/plans/{plan['id']}").status_code == 200
    assert w["vw"].patch(f"/plans/{plan['id']}", json={"name": "z"}).status_code == 403
    assert w["vw"].get(f"/projects/{pid}/plans").json()[0]["level"] == "viewer"
    assert {p["id"]: p for p in w["vw"].get("/projects").json()}[pid]["plan_count"] == 1
    # Projektplan erscheint nicht in /plans ohne Parameter, aber mit project_id und unter /projects/{id}/plans
    assert plan["id"] not in [p["id"] for p in w["ed"].get("/plans").json()]
    assert plan["id"] in [p["id"] for p in w["ed"].get("/plans", params={"project_id": pid}).json()]
    # Außenstehender: weder Plan noch Projekt
    assert w["out"].get(f"/plans/{plan['id']}").status_code == 403
    assert w["out"].post("/plans", json={"name": "N", "map_id": "m1", "project_id": pid}).status_code == 404
    assert w["out"].get("/folders", params={"project_id": pid}).status_code == 404
    # Ordner im Projekt
    f = w["ed"].post("/folders", json={"name": "Ord", "project_id": pid}).json()
    assert f["project_id"] == pid
    assert f["id"] not in [x["id"] for x in w["ed"].get("/folders").json()]
    assert f["id"] in [x["id"] for x in w["vw"].get("/folders", params={"project_id": pid}).json()]
    assert w["vw"].post("/folders", json={"name": "x", "project_id": pid}).status_code == 403
    # Ordner eines anderen Kontexts als Ziel -> 404
    plain = w["admin"].post("/folders", json={"name": "Plain"}).json()
    assert w["ed"].post(f"/plans/{plan['id']}/move", json={"folder_id": plain["id"]}).status_code == 404
    assert w["ed"].post(f"/plans/{plan['id']}/move", json={"folder_id": f["id"]}).status_code == 200
    # Zyklus bei Ordnern
    f2 = w["ed"].post("/folders", json={"name": "Kind", "project_id": pid, "parent_id": f["id"]}).json()
    assert w["ed"].patch(f"/folders/{f['id']}", json={"parent_id": f2["id"]}).status_code == 400
    assert w["ed"].patch(f"/folders/{f2['id']}", json={"parent_id": plain["id"]}).status_code == 404


def test_move_plan_between_project_and_images(world):
    w = world
    pid = w["pid"]
    admin = w["admin"]
    _map(admin)
    own = w["builder"]
    r = own.post("/plans", json={"name": "Frei", "map_id": "m1"})
    assert r.status_code == 201, r.text
    plan = r.json()
    up = own.post(f"/plans/{plan['id']}/images", content=PNG, headers={"content-type": "image/png", "x-filename": "a.png"})
    assert up.status_code == 201
    img = up.json()
    # ein Editor ohne Plan-owner kann nicht verschieben
    assert w["ed"].post(f"/plans/{plan['id']}/project", json={"project_id": pid}).status_code == 403
    # Projekt-Editor nötig
    assert w["vw"].post(f"/plans/{plan['id']}/project", json={"project_id": pid}).status_code == 403
    mv = own.post(f"/plans/{plan['id']}/project", json={"project_id": pid})
    assert mv.status_code == 200 and mv.json()["project_id"] == pid
    # Bild erscheint im Projekt (Öffentlich), Rohdaten für Projekt-Viewer lesbar
    lst = w["vw"].get(f"/projects/{pid}/images").json()
    assert [i["id"] for i in lst] == [img["id"]] and lst[0]["plan_name"] == "Frei"
    # Rohdaten folgen nur den Plan-Rechten: Projekt-Viewer ohne Plan-ACL -> 403
    assert w["vw"].get(f"/plans/{plan['id']}/images/{img['id']}/raw").status_code == 403
    assert own.get(f"/plans/{plan['id']}/images/{img['id']}/raw").content == PNG
    # Builder-Phase-Bild nur im Missionsbau-Bereich
    bph = next(p for p in own.get(f"/plans/{plan['id']}/phases").json() if p["plane"] == "builder")
    bimg = own.post(f"/plans/{plan['id']}/images", params={"phase_id": bph["id"]}, content=PNG,
                    headers={"content-type": "image/png"}).json()
    assert bimg["id"] not in [i["id"] for i in w["ed"].get(f"/projects/{pid}/images").json()]
    assert [i["id"] for i in own.get(f"/projects/{pid}/images", params={"space": "builder"}).json()] == [bimg["id"]]
    assert w["ed"].delete(f"/projects/{pid}/images/{bimg['id']}").status_code == 404
    assert w["vw"].delete(f"/projects/{pid}/images/{img['id']}").status_code == 403
    assert w["ed"].patch(f"/projects/{pid}/images/{img['id']}", json={"caption": "Name"}).json()["caption"] == "Name"
    # Speicherauswertung nur Admin
    assert w["ed"].get("/api/admin/projects/storage").status_code == 403
    st = admin.get("/api/admin/projects/storage").json()
    row = next(x for x in st if x["project_id"] == pid)
    assert row["images_bytes"] == 2 * len(PNG) and row["plans_count"] == 1
    assert row["total_bytes"] == row["images_bytes"] + row["docs_bytes"]
    # Herauslösen zieht Bilder nach
    assert own.post(f"/plans/{plan['id']}/project", json={"project_id": None}).json()["project_id"] is None
    assert w["ed"].get(f"/projects/{pid}/images").json() == []
    # Löschen
    assert w["ed"].delete(f"/projects/{pid}").status_code == 403
    assert own.delete(f"/projects/{pid}").status_code == 200
    assert own.get(f"/projects/{pid}").status_code == 404
    assert own.get(f"/plans/{plan['id']}").status_code == 200  # Plan bleibt


def test_delete_project_keeps_plans(world):
    w = world
    pid = w["pid"]
    _map(w["admin"])
    plan = w["ed"].post("/plans", json={"name": "Bleibt", "map_id": "m1", "project_id": pid}).json()
    f = w["ed"].post("/folders", json={"name": "F", "project_id": pid}).json()
    w["ed"].post(f"/plans/{plan['id']}/move", json={"folder_id": f["id"]})
    assert w["builder"].delete(f"/projects/{pid}").status_code == 200
    got = w["ed"].get(f"/plans/{plan['id']}")
    assert got.status_code == 200 and got.json()["project_id"] is None and got.json()["folder_id"] is None


def test_archived_is_readonly(world):
    w = world
    pid = w["pid"]
    w["builder"].patch(f"/projects/{pid}", json={"archived": True})
    assert w["ed"].post(f"/projects/{pid}/notes", json={"text": "x"}).status_code == 403
    assert w["ed"].get(f"/projects/{pid}/notes").status_code == 200
    assert w["builder"].patch(f"/projects/{pid}", json={"archived": False}).status_code == 200


def test_project_editor_with_plan_acl_via_group(world):
    """Projekt-editor ohne Plan-ACL: 403 auf Plan, Marker/Zeichnen; mit Plan-ACL der Gruppe: ok."""
    w = world
    pid = w["pid"]
    admin = w["admin"]
    _map(admin)
    plan = w["builder"].post("/plans", json={"name": "P", "map_id": "m1", "project_id": pid}).json()
    prid = plan["id"]
    assert w["ed"].get(f"/plans/{prid}").status_code == 403
    assert w["ed"].patch(f"/plans/{prid}", json={"name": "x"}).status_code == 403
    assert w["ed"].get(f"/plans/{prid}/images").status_code == 403
    assert w["ed"].post(f"/plans/{prid}/clone", json={"name": "K"}).status_code == 403
    assert prid not in [p["id"] for p in w["ed"].get(f"/projects/{pid}/plans").json()]
    g = admin.post("/api/admin/groups", json={"name": f"g{next(_n)}"})
    assert g.status_code in (200, 201), g.text
    gid = g.json()["id"]
    r = admin.put(f"/api/admin/groups/{gid}/members", json=[w["eid"]])
    assert r.status_code == 200, r.text
    acl = [{"subject_type": "user", "subject_id": w["bid"], "level": "owner"},
           {"subject_type": "group", "subject_id": gid, "level": "editor"}]
    assert w["builder"].put(f"/plans/{prid}/acl", json=acl).status_code == 200
    assert w["ed"].get(f"/plans/{prid}").status_code == 200
    assert w["ed"].patch(f"/plans/{prid}", json={"name": "x"}).status_code == 200
    assert prid in [p["id"] for p in w["ed"].get(f"/projects/{pid}/plans").json()]


def test_plans_in_projects_listing_follows_plan_acl(world):
    """Projekt-Pläne erscheinen unter „Projekte" nur mit Plan-Freigabe – auch für Nicht-Projektmitglieder."""
    w = world
    _map(w["admin"])
    plan = w["builder"].post("/plans", json={"name": "PP", "map_id": "m1", "project_id": w["pid"]}).json()
    prid = plan["id"]
    assert prid not in [p["id"] for p in w["out"].get("/plans/in-projects").json()]
    acl = [{"subject_type": "user", "subject_id": w["bid"], "level": "owner"},
           {"subject_type": "user", "subject_id": w["oid"], "level": "viewer"}]
    assert w["builder"].put(f"/plans/{prid}/acl", json=acl).status_code == 200
    rows = [p for p in w["out"].get("/plans/in-projects").json() if p["id"] == prid]
    assert len(rows) == 1 and rows[0]["project_name"] == "Op Test" and rows[0]["level"] == "viewer"
    assert prid not in [p["id"] for p in w["out"].get("/plans").json()]  # normale Liste bleibt projektfrei


def test_last_project_setting(world):
    w = world
    r = w["builder"].patch("/auth/me/settings", json={"last_project": w["pid"]})
    assert r.status_code == 200 and r.json()["ui_settings"]["last_project"] == w["pid"]


def _builder(admin, name):
    return _user(admin, name, is_mission_builder=True)


def test_project_folders(admin):
    a, b, c = _names()
    b1, b1id = _builder(admin, a)
    b2, b2id = _builder(admin, b)
    plain, plainid = _user(admin, c)
    # Anlegen: nur Builder/Admin
    assert plain.post("/project-folders", json={"name": "X"}).status_code == 403
    f1 = b1.post("/project-folders", json={"name": "Einsatz"}).json()
    f2 = b1.post("/project-folders", json={"name": "Unter", "parent_id": f1["id"]}).json()
    assert f2["parent_id"] == f1["id"]
    # leere fremde Ordner sind fuer b2 nicht sichtbar, fuer Admin schon
    assert b2.get("/project-folders").json() == []
    assert {f["id"] for f in admin.get("/project-folders").json()} >= {f1["id"], f2["id"]}
    # Projekt im Unterordner -> Ordner + Vorfahr fuer Mitglied sichtbar, andere nicht
    pr = b1.post("/projects", json={"name": "P1", "folder_id": f2["id"]})
    assert pr.status_code == 201 and pr.json()["folder_id"] == f2["id"]
    pid = pr.json()["id"]
    assert b1.put(f"/projects/{pid}/members", json=[
        {"subject_type": "user", "subject_id": b1id, "role": "owner"},
        {"subject_type": "user", "subject_id": plainid, "role": "viewer"}]).status_code == 200
    assert {f["id"] for f in plain.get("/project-folders").json()} == {f1["id"], f2["id"]}
    assert b2.get("/project-folders").json() == []
    assert [p["folder_id"] for p in plain.get("/projects").json()] == [f2["id"]]
    # Rechte: nur Ersteller/Admin aendern; Sichtbarkeit ohne Zugriff -> 404
    assert plain.patch(f"/project-folders/{f1['id']}", json={"name": "Z"}).status_code == 403
    assert plain.delete(f"/project-folders/{f1['id']}").status_code == 403
    assert b2.patch(f"/project-folders/{f1['id']}", json={"name": "Z"}).status_code == 404
    assert b1.patch(f"/project-folders/{f1['id']}", json={"name": "Neu"}).json()["name"] == "Neu"
    # Zyklus
    assert b1.patch(f"/project-folders/{f1['id']}", json={"parent_id": f2["id"]}).status_code == 400
    assert b1.patch(f"/project-folders/{f1['id']}", json={"parent_id": f1["id"]}).status_code == 400
    # Projekt verschieben: nur owner; viewer 403
    assert plain.patch(f"/projects/{pid}", json={"folder_id": None}).status_code == 403
    assert b1.patch(f"/projects/{pid}", json={"folder_id": "gibts-nicht"}).status_code == 404
    assert b1.patch(f"/projects/{pid}", json={"description": "d"}).json()["folder_id"] == f2["id"]
    # Loeschen von f1: Unterordner rueckt in die Wurzel, f2 behaelt Projekt
    assert b1.delete(f"/project-folders/{f1['id']}").status_code == 200
    got = {f["id"]: f for f in b1.get("/project-folders").json()}
    assert f1["id"] not in got and got[f2["id"]]["parent_id"] is None
    # Loeschen von f2: Projekt rueckt auf oberste Ebene (folder_id = NULL)
    f3 = b1.post("/project-folders", json={"name": "Mitte"}).json()
    assert b1.patch(f"/project-folders/{f2['id']}", json={"parent_id": f3["id"]}).json()["parent_id"] == f3["id"]
    assert b1.delete(f"/project-folders/{f3['id']}").status_code == 200
    assert b1.get(f"/project-folders").json()[0]["parent_id"] is None
    assert b1.delete(f"/project-folders/{f2['id']}").status_code == 200
    assert b1.get(f"/projects/{pid}").json()["folder_id"] is None
    # Verschieben zurueck per move_to_root / null
    f4 = b1.post("/project-folders", json={"name": "A"}).json()
    assert b1.patch(f"/projects/{pid}", json={"folder_id": f4["id"]}).json()["folder_id"] == f4["id"]
    assert b1.patch(f"/projects/{pid}", json={"folder_id": None}).json()["folder_id"] is None
    # Admin darf fremde Ordner loeschen
    assert admin.delete(f"/project-folders/{f4['id']}").status_code == 200


def test_plan_folder_rights(admin):
    a, b, c = _names()
    u1, _ = _user(admin, a, can_create_plans=True)
    u2, _ = _user(admin, b, can_create_plans=True)
    nope, _ = _user(admin, c)
    assert nope.post("/folders", json={"name": "X"}).status_code == 403
    f = u1.post("/folders", json={"name": "Meiner"}).json()
    assert f["created_by"]
    # fremder Ordner -> 403 (auch mit can_create_plans)
    assert u2.patch(f"/folders/{f['id']}", json={"name": "Z"}).status_code == 403
    assert u2.delete(f"/folders/{f['id']}").status_code == 403
    assert nope.delete(f"/folders/{f['id']}").status_code == 403
    assert u1.patch(f"/folders/{f['id']}", json={"name": "Neu"}).json()["name"] == "Neu"
    # Ordner im Ordner eines anderen anlegen ist erlaubt (Anlegen = can_create_plans)
    sub = u2.post("/folders", json={"name": "Sub", "parent_id": f["id"]})
    assert sub.status_code == 201
    # Admin darf alles
    assert admin.patch(f"/folders/{sub.json()['id']}", json={"name": "A"}).status_code == 200
    assert admin.delete(f"/folders/{sub.json()['id']}").status_code == 200
    assert u1.delete(f"/folders/{f['id']}").status_code == 200
    # Alt-Ordner (created_by NULL): Admin + can_create_plans; sonst 403
    from app.db import SessionLocal
    from app.models import PlanFolder

    with SessionLocal() as db:
        old = PlanFolder(name="Alt", ordering=99)
        db.add(old)
        db.commit()
        oid = old.id
    assert nope.patch(f"/folders/{oid}", json={"name": "z"}).status_code == 403
    assert nope.delete(f"/folders/{oid}").status_code == 403
    assert u2.patch(f"/folders/{oid}", json={"name": "z"}).status_code == 200
    assert u1.delete(f"/folders/{oid}").status_code == 200
