"""Missionsbau-Werkzeuge Phase 1: Verknüpfungs-Codes, Rückverweise, Suche, Dateitypen, Zeitleiste."""
import itertools
import json

import pytest
from fastapi.testclient import TestClient

from app.main import app

PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000020000000208020000007b40e8dd0000001049444154789c63f8cf"
    "c0c0440c1008000 01fee03fd8b5f14d40000000049454e44ae426082".replace(" ", "")
)
PW = "pw-1234567890"
_n = itertools.count(1)
A32 = "a" * 32  # wohlgeformte, aber nicht vorhandene ID


def _user(admin, name, **flags):
    r = admin.post("/api/admin/users", json={"username": name, "password": PW, "role": "user", **flags})
    assert r.status_code == 201, r.text
    c = TestClient(app)
    assert c.post("/auth/login", json={"username": name, "password": PW}).status_code == 200
    return c, r.json()["id"]


def _map(admin):
    admin.post("/api/maps", json={"id": "m1", "name": "M1", "url": "http://x.invalid/a.zip"})
    from app.db import SessionLocal
    from app.models import Map, now
    from app.services.maps_import import map_dir

    with SessionLocal() as db:
        m = db.get(Map, "m1")
        if m is not None:
            m.status = "ready"
            m.imported_at = now()
            db.commit()
    d = map_dir("m1")
    d.mkdir(parents=True, exist_ok=True)
    (d / "locations.json").write_text(json.dumps({"langs": ["en_us"], "groups": [{
        "key": "town", "label": "Orte",
        "items": [{"names": {"en_us": "Montignac", "fr_fr": "Montignac FR"}, "lon": 0, "lat": 0}],
    }]}), encoding="utf-8")


@pytest.fixture
def world(admin):
    """builder (Missionsbauer, owner), ed (editor), vw (viewer), out (Außenstehender)."""
    k = next(_n)
    a, b, c = f"t{k}a", f"t{k}b", f"t{k}c"
    builder, bid = _user(admin, a, is_mission_builder=True, can_create_plans=True)
    ed, eid = _user(admin, b)
    vw, vid = _user(admin, c)
    out, _ = _user(admin, a + "x")
    pid = builder.post("/projects", json={"name": "Op Tools"}).json()["id"]
    r = builder.put(f"/projects/{pid}/members", json=[
        {"subject_type": "user", "subject_id": bid, "role": "owner"},
        {"subject_type": "user", "subject_id": eid, "role": "editor"},
        {"subject_type": "user", "subject_id": vid, "role": "viewer"},
    ])
    assert r.status_code == 200, r.text
    return dict(admin=admin, builder=builder, ed=ed, vw=vw, out=out, pid=pid, eid=eid, vid=vid)


def _doc(c, pid, name, content="", space="public", **extra):
    r = c.post(f"/projects/{pid}/docs", json={"space": space, "kind": "doc", "name": name, "content": content, **extra})
    assert r.status_code == 201, r.text
    return r.json()


def _resolve(c, pid, refs):
    r = c.post(f"/projects/{pid}/refs/resolve", json={"refs": [{"type": t, "id": i} for t, i in refs]})
    assert r.status_code == 200, r.text
    return r.json()


def _back(c, pid, typ, tid):
    r = c.get(f"/projects/{pid}/refs/backlinks", params={"type": typ, "id": tid})
    assert r.status_code == 200, r.text
    return r.json()


def test_resolve_rights(world):
    w = world
    pid, builder, ed, vw = w["pid"], w["builder"], w["ed"], w["vw"]
    _map(w["admin"])
    pub = _doc(ed, pid, "Konzept")
    bld = _doc(builder, pid, "Geheim", space="builder")
    folder = builder.post(f"/projects/{pid}/docs", json={"space": "public", "kind": "folder", "name": "Ordner"}).json()
    task = ed.post(f"/projects/{pid}/tasks", json={"title": "Aufgabe 1"}).json()
    note = ed.post(f"/projects/{pid}/notes", json={"text": "Erste Zeile\nZweite"}).json()
    plan = ed.post("/plans", json={"name": "Plan Alpha", "map_id": "m1", "project_id": pid}).json()
    up = builder.post("/plans", json={"name": "P2", "map_id": "m1", "project_id": pid}).json()
    img = builder.post(f"/plans/{up['id']}/images", content=PNG,
                       headers={"content-type": "image/png", "x-filename": "a.png"}).json()
    bph = next(p for p in builder.get(f"/plans/{up['id']}/phases").json() if p["plane"] == "builder")
    bimg = builder.post(f"/plans/{up['id']}/images", params={"phase_id": bph["id"]}, content=PNG,
                        headers={"content-type": "image/png"}).json()

    refs = [("doc", pub["id"]), ("doc", bld["id"]), ("doc", folder["id"]), ("task", task["id"]),
            ("note", note["id"]), ("plan", plan["id"]), ("img", img["id"]), ("img", bimg["id"]),
            ("place", "m1:Montignac"), ("place", "m1:Nirgendwo"), ("place", "gibts-nicht:Montignac"),
            ("doc", A32), ("doc", "kaputt")]
    res = _resolve(builder, pid, refs)
    assert [r["ok"] for r in res] == [True, True, False, True, True, False, True, True, True, False, False, False, False]
    assert [(r["type"], r["id"]) for r in res] == refs
    by = {(r["type"], r["id"]): r for r in res}
    d = by[("doc", pub["id"])]
    assert d["label"] == "Konzept" and d["href"] == f"#/projects/{pid}/public?doc={pub['id']}" and d["sub"] == "Öffentlich"
    assert by[("doc", bld["id"])]["href"] == f"#/projects/{pid}/builder?doc={bld['id']}"
    assert by[("task", task["id"])]["href"] == f"#/projects/{pid}/tasks?task={task['id']}"
    assert by[("note", note["id"])]["label"] == "Erste Zeile"
    assert by[("note", note["id"])]["href"] == f"#/projects/{pid}/whiteboard?note={note['id']}"
    assert by[("img", img["id"])]["href"] == f"#/projects/{pid}/public?img={img['id']}"
    assert by[("img", bimg["id"])]["href"] == f"#/projects/{pid}/builder?img={bimg['id']}"
    p = by[("place", "m1:Montignac")]
    assert p["label"] == "Montignac" and p["sub"] == "M1"
    assert p["href"] == f"#/projects/{pid}/places?map=m1&name=Montignac"
    assert _resolve(builder, pid, [("place", "m1:Montignac FR")])[0]["ok"] is True  # andere Sprache
    miss = by[("doc", A32)]
    assert miss["label"] == "" and miss["href"] == "" and miss["sub"] == ""

    # Editor ohne Missionsbauer: Builder-Doc/-Bild unsichtbar; Plan nur laut Plan-Recht (Ersteller sieht ihn)
    res = _resolve(ed, pid, refs)
    ok = {(r["type"], r["id"]): r for r in res}
    assert not ok[("doc", bld["id"])]["ok"] and ok[("doc", bld["id"])]["label"] == ""
    assert not ok[("img", bimg["id"])]["ok"] and ok[("img", img["id"])]["ok"]
    assert ok[("plan", plan["id"])]["ok"] and ok[("plan", plan["id"])]["href"] == f"#/plans/{plan['id']}"
    # Betrachter ohne Plan-ACL sieht den Plan nicht, Aufgaben/Notizen/öffentliche Dateien aber schon
    ok = {(r["type"], r["id"]): r for r in _resolve(vw, pid, refs)}
    assert not ok[("plan", plan["id"])]["ok"]
    assert ok[("doc", pub["id"])]["ok"] and ok[("task", task["id"])]["ok"] and ok[("note", note["id"])]["ok"]
    # Außenstehende: kein Projektzugriff
    assert w["out"].post(f"/projects/{pid}/refs/resolve", json={"refs": []}).status_code == 404
    # Ziel aus anderem Projekt -> nicht ok
    pid2 = builder.post("/projects", json={"name": "Anderes"}).json()["id"]
    assert _resolve(builder, pid2, [("doc", pub["id"]), ("task", task["id"])]) == [
        {"type": "doc", "id": pub["id"], "label": "", "sub": "", "href": "", "ok": False},
        {"type": "task", "id": task["id"], "label": "", "sub": "", "href": "", "ok": False}]
    # Limit 200
    too_many = {"refs": [{"type": "doc", "id": A32}] * 201}
    assert builder.post(f"/projects/{pid}/refs/resolve", json=too_many).status_code == 422
    assert builder.post(f"/projects/{pid}/refs/resolve", json={"refs": [{"type": "x", "id": "1"}]}).status_code == 422


def test_backlinks_lifecycle(world):
    w = world
    pid, builder, ed = w["pid"], w["builder"], w["ed"]
    target = _doc(ed, pid, "Ziel")
    code = "{{doc:%s}}" % target["id"]
    a = _doc(ed, pid, "Quelle A", "Siehe " + code + " und nochmal " + code)
    secret = _doc(builder, pid, "Quelle Geheim", code, space="builder")
    task = ed.post(f"/projects/{pid}/tasks", json={"title": "T", "description": "Mehr in " + code}).json()
    note = ed.post(f"/projects/{pid}/notes", json={"text": code}).json()

    got = _back(ed, pid, "doc", target["id"])
    assert {(x["type"], x["id"]) for x in got} == {("doc", a["id"]), ("task", task["id"]), ("note", note["id"])}
    assert all(x["label"] and x["href"] for x in got) and len(got) == 3  # Duplikat im Text zählt einmal
    assert {x["id"] for x in _back(builder, pid, "doc", target["id"])} == {a["id"], secret["id"], task["id"], note["id"]}
    assert _back(w["vw"], pid, "doc", target["id"])  # Betrachter dürfen lesen

    # Bearbeiten baut den Index neu auf
    assert ed.patch(f"/projects/{pid}/docs/{a['id']}", json={"content": "ohne Verweis"}).status_code == 200
    assert a["id"] not in {x["id"] for x in _back(ed, pid, "doc", target["id"])}
    assert ed.patch(f"/projects/{pid}/tasks/{task['id']}", json={"description": ""}).status_code == 200
    assert ed.patch(f"/projects/{pid}/tasks/{task['id']}", json={"title": "Titel " + code}).status_code == 200
    assert task["id"] in {x["id"] for x in _back(ed, pid, "doc", target["id"])}  # Titel zählt mit
    assert ed.patch(f"/projects/{pid}/notes/{note['id']}", json={"text": "leer"}).status_code == 200
    assert note["id"] not in {x["id"] for x in _back(ed, pid, "doc", target["id"])}
    # Löschen entfernt die Quelle
    assert ed.delete(f"/projects/{pid}/tasks/{task['id']}").status_code == 200
    assert _back(ed, pid, "doc", target["id"]) == []
    # Ordner löschen räumt Dateien darin mit auf
    fo = builder.post(f"/projects/{pid}/docs", json={"space": "public", "kind": "folder", "name": "F"}).json()
    _doc(builder, pid, "Im Ordner", code, parent_id=fo["id"])
    assert len(_back(ed, pid, "doc", target["id"])) == 1
    assert builder.delete(f"/projects/{pid}/docs/{fo['id']}").status_code == 200
    assert _back(ed, pid, "doc", target["id"]) == []
    # Nicht sichtbares Ziel -> leer; andere Typen (Notiz/Ort)
    assert _back(ed, pid, "doc", secret["id"]) == []
    note2 = ed.post(f"/projects/{pid}/notes", json={"text": "x"}).json()
    ed.patch(f"/projects/{pid}/notes/{note2['id']}", json={"text": "{{note:%s}}" % note2["id"]})
    assert [x["id"] for x in _back(ed, pid, "note", note2["id"])] == [note2["id"]]
    assert w["out"].get(f"/projects/{pid}/refs/backlinks", params={"type": "doc", "id": target["id"]}).status_code == 404
    # Projekt löschen räumt auf
    assert builder.delete(f"/projects/{pid}").status_code == 200


def test_search(world):
    w = world
    pid, builder, ed = w["pid"], w["builder"], w["ed"]
    _doc(ed, pid, "Zulu", "Hier steht etwas über Alpha im Text. " * 3)
    _doc(ed, pid, "Alpha Basis", "nichts")
    _doc(ed, pid, "Prozent 100%", "x")
    _doc(ed, pid, "Unterstrich", "wert a_b gefunden")
    _doc(ed, pid, "Kein Treffer", "wert aXb")
    _doc(builder, pid, "Geheim Alpha", "alpha intern", space="builder")
    ed.post(f"/projects/{pid}/tasks", json={"title": "Alpha Aufgabe", "description": "Beschreibung"})
    ed.post(f"/projects/{pid}/tasks", json={"title": "Andere", "description": "enthält ALPHA versteckt"})
    ed.post(f"/projects/{pid}/notes", json={"text": "Notiz mit alpha"})
    plan = ed.post("/plans", json={"name": "Alpha Plan", "map_id": "m1", "project_id": pid})
    if plan.status_code != 201:
        _map(w["admin"])
        plan = ed.post("/plans", json={"name": "Alpha Plan", "map_id": "m1", "project_id": pid})
    assert plan.status_code == 201, plan.text

    def s(c, q, **p):
        r = c.get(f"/projects/{pid}/search", params={"q": q, **p})
        assert r.status_code == 200, r.text
        return r.json()

    res = s(ed, "alpha")
    labels = [(r["type"], r["label"]) for r in res]
    # Titeltreffer zuerst, dann Inhaltstreffer; Builder-Datei für Nicht-Builder unsichtbar
    assert labels[:3] == [("doc", "Alpha Basis"), ("task", "Alpha Aufgabe"), ("plan", "Alpha Plan")]
    assert {("doc", "Zulu"), ("task", "Andere"), ("note", "Notiz mit alpha")} == set(labels[3:])
    assert ("doc", "Geheim Alpha") not in labels
    first = res[0]
    assert set(first) == {"type", "id", "label", "sub", "href", "snippet"}
    zulu = next(r for r in res if r["label"] == "Zulu")
    assert "Alpha" in zulu["snippet"] and len(zulu["snippet"]) <= 125
    andere = next(r for r in res if r["label"] == "Andere")
    assert "ALPHA" in andere["snippet"]
    assert ("doc", "Geheim Alpha") in [(r["type"], r["label"]) for r in s(builder, "alpha")]
    # Filter
    assert {r["type"] for r in s(ed, "alpha", types="plan,note")} == {"plan", "note"}
    assert ed.get(f"/projects/{pid}/search", params={"q": "alpha", "types": "foo"}).status_code == 400
    assert [r["label"] for r in s(builder, "alpha", types="doc", space="builder")] == ["Geheim Alpha"]
    assert ed.get(f"/projects/{pid}/search", params={"q": "alpha", "space": "builder"}).status_code == 404
    assert len(s(ed, "alpha", limit=2)) == 2
    assert ed.get(f"/projects/{pid}/search", params={"q": "alpha", "limit": 51}).status_code == 422
    # Mindestlänge
    assert ed.get(f"/projects/{pid}/search", params={"q": "a"}).status_code == 400
    assert ed.get(f"/projects/{pid}/search", params={"q": " a "}).status_code == 400
    # Wildcards sind wörtlich
    assert [r["label"] for r in s(ed, "0%")] == ["Prozent 100%"]
    assert [r["label"] for r in s(ed, "a_b")] == ["Unterstrich"]
    assert s(ed, "%%") == []
    assert s(ed, "_ _") == []
    assert s(ed, "nichtvorhanden") == []
    assert w["out"].get(f"/projects/{pid}/search", params={"q": "alpha"}).status_code == 404


def test_doc_type(world):
    w = world
    pid, ed, builder = w["pid"], w["ed"], w["builder"]
    d = _doc(ed, pid, "Figur", "x", doc_type="character")
    assert d["doc_type"] == "character"
    assert _doc(ed, pid, "Ohne")["doc_type"] == ""
    bad = ed.post(f"/projects/{pid}/docs", json={"space": "public", "kind": "doc", "name": "n", "doc_type": "foo"})
    assert bad.status_code == 422
    _doc(ed, pid, "Ort", doc_type="place")
    lst = ed.get(f"/projects/{pid}/docs").json()
    assert {x["name"]: x["doc_type"] for x in lst} == {"Figur": "character", "Ohne": "", "Ort": "place"}
    assert [x["name"] for x in ed.get(f"/projects/{pid}/docs", params={"type": "character"}).json()] == ["Figur"]
    assert ed.get(f"/projects/{pid}/docs", params={"type": "foo"}).status_code == 422
    assert ed.get(f"/projects/{pid}/docs", params={"type": ""}).status_code == 422
    # Typ ändern
    r = ed.patch(f"/projects/{pid}/docs/{d['id']}", json={"doc_type": "scene"})
    assert r.status_code == 200 and r.json()["doc_type"] == "scene"
    assert ed.patch(f"/projects/{pid}/docs/{d['id']}", json={"doc_type": "foo"}).status_code == 422
    assert ed.get(f"/projects/{pid}/docs/{d['id']}").json()["doc_type"] == "scene"
    assert ed.patch(f"/projects/{pid}/docs/{d['id']}", json={"doc_type": ""}).json()["doc_type"] == ""
    # Ordner haben keinen Typ
    fo = builder.post(f"/projects/{pid}/docs", json={"space": "public", "kind": "folder", "name": "F", "doc_type": "scene"}).json()
    assert fo["doc_type"] == ""
    assert builder.patch(f"/projects/{pid}/docs/{fo['id']}", json={"doc_type": "scene"}).status_code == 400
    # Typ-Filter respektiert den Missionsbau-Bereich
    assert ed.get(f"/projects/{pid}/docs", params={"space": "builder", "type": "place"}).status_code == 404


TL = """# Titel
## 06:30 Anmarsch
## Tag 2 · 06:30 Angriff
## T2 06:30 Zweiter
## T+01:30 Feindkontakt
## H+90 Rückzug
### 18:00 Abend ##
## Kein Zeitpunkt
## 25:00 ungültig
```
## 07:00 Im Code
```
~~~md
## 08:00 Auch im Code
~~~
## 12:00 Nach dem Code
"""


def test_timeline(world):
    w = world
    pid, builder, ed = w["pid"], w["builder"], w["ed"]
    d = _doc(ed, pid, "Ablauf", TL)
    _doc(builder, pid, "Geheimablauf", "## 05:00 Geheimstart\n", space="builder")
    _doc(ed, pid, "Ohne Zeit", "# Nur Text\n")

    res = ed.get(f"/projects/{pid}/timeline").json()
    got = [(r["heading"], r["day"], r["minutes"], r["relative"], r["level"]) for r in res]
    assert got == [
        ("Anmarsch", 1, 390, False, 2),
        ("Nach dem Code", 1, 720, False, 2),
        ("Abend", 1, 1080, False, 3),
        ("Angriff", 2, 390, False, 2),
        ("Zweiter", 2, 390, False, 2),
        ("Feindkontakt", None, 90, True, 2),
        ("Rückzug", None, 90, True, 2),
    ]
    first = res[0]
    assert first["doc_id"] == d["id"] and first["doc_name"] == "Ablauf" and first["space"] == "public"
    assert first["position"] == 2
    assert first["href"] == f"#/projects/{pid}/public?doc={d['id']}&line=2"
    assert w["vw"].get(f"/projects/{pid}/timeline").json() == res
    # Missionsbau-Einträge nur für Missionsbauer, eingeordnet nach Zeit
    bres = builder.get(f"/projects/{pid}/timeline").json()
    assert [r["heading"] for r in bres][:2] == ["Geheimstart", "Anmarsch"]
    assert bres[0]["space"] == "builder" and bres[0]["href"].startswith(f"#/projects/{pid}/builder?doc=")
    assert w["out"].get(f"/projects/{pid}/timeline").status_code == 404

    # Speichern baut neu auf, Löschen räumt auf
    assert ed.patch(f"/projects/{pid}/docs/{d['id']}", json={"content": "## 09:15 Neu\n"}).status_code == 200
    assert [r["heading"] for r in ed.get(f"/projects/{pid}/timeline").json()] == ["Neu"]
    assert ed.patch(f"/projects/{pid}/docs/{d['id']}", json={"content": "kein Titel"}).status_code == 200
    assert ed.get(f"/projects/{pid}/timeline").json() == []
    fo = builder.post(f"/projects/{pid}/docs", json={"space": "public", "kind": "folder", "name": "F"}).json()
    _doc(builder, pid, "In Ordner", "## 10:00 A\n## 11:00 B\n", parent_id=fo["id"])
    assert len(ed.get(f"/projects/{pid}/timeline").json()) == 2
    assert builder.delete(f"/projects/{pid}/docs/{fo['id']}").status_code == 200
    assert ed.get(f"/projects/{pid}/timeline").json() == []


def test_timeline_parser_variants():
    from app.services.timeline import parse

    def one(line):
        r = parse(line)
        return (r[0]["heading"], r[0]["day"], r[0]["minutes"], r[0]["relative"]) if r else None

    assert one("# 6:05 Früh") == ("Früh", 1, 365, False)
    assert one("## 06:30 Uhr - Anmarsch") == ("Anmarsch", 1, 390, False)
    assert one("## Tag 3 - 00:10 Nacht") == ("Nacht", 3, 10, False)
    assert one("## day 2 23:59 Ende") == ("Ende", 2, 1439, False)
    assert one("## t+0:45 Kurz") == ("Kurz", None, 45, True)
    assert one("## H+120") == ("H+120", None, 120, True)  # ohne Titel bleibt die Überschrift
    assert one("## Tag 0 06:00 x") is None
    assert one("## 06:60 x") is None
    assert one("## Anmarsch 06:30") is None  # Zeit nur am Anfang
    assert one("Text 06:30") is None
    assert one("    ## 06:30 eingerückt") is None
