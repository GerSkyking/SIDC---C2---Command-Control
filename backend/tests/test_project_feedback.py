"""Missionsbau-Werkzeuge Phase 2: Feedback (intern/extern), Status & Meilensteine, Dok-Kommentare, Dok-Versionen."""
import itertools
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.main import app

PW = "pw-1234567890"
_n = itertools.count(1)
A32 = "a" * 32


def _user(admin, name, **flags):
    r = admin.post("/api/admin/users", json={"username": name, "password": PW, "role": "user", **flags})
    assert r.status_code == 201, r.text
    c = TestClient(app)
    assert c.post("/auth/login", json={"username": name, "password": PW}).status_code == 200
    return c, r.json()["id"]


@pytest.fixture
def world(admin):
    """builder (Missionsbauer, owner), ed (editor), vw (viewer), out (Außenstehender), anon (ohne Login)."""
    k = next(_n)
    a, b, c = f"f{k}a", f"f{k}b", f"f{k}c"
    builder, bid = _user(admin, a, is_mission_builder=True, can_create_plans=True)
    ed, eid = _user(admin, b)
    vw, vid = _user(admin, c)
    out, _ = _user(admin, a + "x")
    pid = builder.post("/projects", json={"name": "Op Feedback"}).json()["id"]
    r = builder.put(f"/projects/{pid}/members", json=[
        {"subject_type": "user", "subject_id": bid, "role": "owner"},
        {"subject_type": "user", "subject_id": eid, "role": "editor"},
        {"subject_type": "user", "subject_id": vid, "role": "viewer"},
    ])
    assert r.status_code == 200, r.text
    return dict(admin=admin, builder=builder, ed=ed, vw=vw, out=out, pid=pid, eid=eid, vid=vid, anon=TestClient(app))


def _doc(c, pid, name, content="", space="public"):
    r = c.post(f"/projects/{pid}/docs", json={"space": space, "kind": "doc", "name": name, "content": content})
    assert r.status_code == 201, r.text
    return r.json()


def _token(w):
    r = w["builder"].post(f"/projects/{w['pid']}/feedback-token")
    assert r.status_code == 200, r.text
    return r.json()["token"]


# ─── Token + öffentliche Schnittstelle ─────────────────────────────────────

def test_token_lifecycle(world):
    w = world
    pid, b = w["pid"], w["builder"]
    assert b.get(f"/projects/{pid}/feedback-token").json() == {"enabled": False, "token": None, "path": None}
    t1 = _token(w)
    assert len(t1) == 40
    got = b.get(f"/projects/{pid}/feedback-token").json()
    assert got == {"enabled": True, "token": t1, "path": f"/api/public/feedback/{t1}"}
    # nur Owner
    assert w["ed"].get(f"/projects/{pid}/feedback-token").status_code == 403
    assert w["ed"].post(f"/projects/{pid}/feedback-token").status_code == 403
    assert w["ed"].delete(f"/projects/{pid}/feedback-token").status_code == 403
    assert w["out"].get(f"/projects/{pid}/feedback-token").status_code == 404
    # rotieren: altes Token tot
    t2 = _token(w)
    assert t2 != t1
    assert w["anon"].get(f"/api/public/feedback/{t1}").status_code == 404
    info = w["anon"].get(f"/api/public/feedback/{t2}")
    assert info.status_code == 200
    assert info.json() == {"project": "Op Feedback", "kinds": ["bug", "idea", "praise", "other"]}
    # abschalten
    assert b.delete(f"/projects/{pid}/feedback-token").json()["enabled"] is False
    assert w["anon"].get(f"/api/public/feedback/{t2}").status_code == 404
    assert w["anon"].post(f"/api/public/feedback/{t2}", json={"title": "x"}).status_code == 404


def test_public_submit(world):
    w = world
    pid, anon = w["pid"], w["anon"]
    tok = _token(w)
    url = f"/api/public/feedback/{tok}"
    r = anon.post(url, json={"title": "  Brücke fehlt ", "text": "<b>x</b> bei 040/040", "kind": "bug", "name": "Gast"})
    assert r.status_code == 201 and r.json() == {"ok": True}
    rows = w["vw"].get(f"/projects/{pid}/feedback").json()
    assert len(rows) == 1
    f = rows[0]
    assert (f["title"], f["text"], f["kind"], f["status"], f["source"], f["author_name"], f["author_user_id"]) == (
        "Brücke fehlt", "<b>x</b> bei 040/040", "bug", "new", "external", "Gast", None)
    # Honeypot: scheinbar ok, aber verworfen
    assert anon.post(url, json={"title": "Spam", "website": "http://spam.invalid"}).status_code == 201
    assert len(w["vw"].get(f"/projects/{pid}/feedback").json()) == 1
    # Validierung
    assert anon.post(url, json={"title": "  "}).status_code == 400
    assert anon.post(url, json={"title": "x" * 201}).status_code == 422
    assert anon.post(url, json={"title": "x", "text": "y" * 5001}).status_code == 422
    assert anon.post(url, json={"title": "x", "kind": "hack"}).status_code == 422
    # falsches / unpassendes Token
    assert anon.post("/api/public/feedback/" + "a" * 40, json={"title": "x"}).status_code == 404
    assert anon.post("/api/public/feedback/kurz", json={"title": "x"}).status_code == 404
    # Archiviert -> 410 (Lesen und Schreiben), danach wieder ok
    assert w["builder"].patch(f"/projects/{pid}", json={"archived": True}).status_code == 200
    assert anon.get(url).status_code == 410
    assert anon.post(url, json={"title": "x"}).status_code == 410
    assert w["builder"].patch(f"/projects/{pid}", json={"archived": False}).status_code == 200
    assert anon.get(url).status_code == 200


def test_public_rate_limit_and_cap(world, monkeypatch):
    from app.routers import project_feedback as pf

    w = world
    anon = w["anon"]
    tok = _token(w)
    url = f"/api/public/feedback/{tok}"
    # je IP
    codes = [anon.post(url, json={"title": f"t{i}"}).status_code for i in range(pf._PUB_IP_POST[0] + 2)]
    assert codes[:pf._PUB_IP_POST[0]] == [201] * pf._PUB_IP_POST[0]
    assert codes[pf._PUB_IP_POST[0]:] == [429, 429]
    # je Token (IP-Limit hoch gesetzt)
    from app import ratelimit

    ratelimit._hits.clear()
    monkeypatch.setattr(pf, "_PUB_IP_POST", (1000, 600.0))
    monkeypatch.setattr(pf, "_PUB_TOKEN_POST", (3, 3600.0))
    assert [anon.post(url, json={"title": "a"}).status_code for _ in range(5)] == [201, 201, 201, 429, 429]
    # Obergrenze je Projekt
    ratelimit._hits.clear()
    monkeypatch.setattr(pf, "_PUB_TOKEN_POST", (1000, 3600.0))
    monkeypatch.setattr(pf, "_MAX_FEEDBACK", 14)  # 10 + 3 + 1 vorhanden
    assert anon.post(url, json={"title": "letztes"}).status_code == 201
    assert anon.post(url, json={"title": "zu viel"}).status_code == 429
    assert w["vw"].post(f"/projects/{w['pid']}/feedback", json={"title": "x"}).status_code == 400


# ─── Internes Feedback ─────────────────────────────────────────────────────

def test_internal_feedback_flow(world):
    w = world
    pid, b, ed, vw = w["pid"], w["builder"], w["ed"], w["vw"]
    d_pub = _doc(ed, pid, "Öffentlich", "x")
    d_sec = _doc(b, pid, "Geheim", "y", space="builder")
    # Betrachter darf posten
    r = vw.post(f"/projects/{pid}/feedback", json={"title": "Idee A", "text": "mehr Deckung", "kind": "idea",
                                                   "doc_id": d_pub["id"]})
    assert r.status_code == 201, r.text
    fa = r.json()
    assert fa["source"] == "internal" and fa["status"] == "new" and fa["author_user_id"] == w["vid"]
    assert fa["doc_id"] == d_pub["id"] and fa["doc_name"] == "Öffentlich" and fa["task_id"] is None
    # Außenstehende nicht
    assert w["out"].post(f"/projects/{pid}/feedback", json={"title": "x"}).status_code == 404
    assert w["out"].get(f"/projects/{pid}/feedback").status_code == 404
    # Missionsbau-Bezug nur wenn sichtbar
    assert vw.post(f"/projects/{pid}/feedback", json={"title": "B", "doc_id": d_sec["id"]}).status_code == 400
    assert ed.post(f"/projects/{pid}/feedback", json={"title": "B", "doc_id": A32}).status_code == 400
    assert ed.post(f"/projects/{pid}/feedback", json={"title": "B", "plan_id": A32}).status_code == 400
    fb = b.post(f"/projects/{pid}/feedback", json={"title": "Bug B", "kind": "bug", "doc_id": d_sec["id"]}).json()
    assert fb["doc_name"] == "Geheim" and fb["doc_space"] == "builder"
    # ... und für Nicht-Missionsbauer in der Liste ausgeblendet
    seen = {f["id"]: f for f in vw.get(f"/projects/{pid}/feedback").json()}
    assert seen[fb["id"]]["doc_id"] is None and seen[fb["id"]]["doc_name"] is None

    # Filter
    ids = lambda **p: {f["id"] for f in vw.get(f"/projects/{pid}/feedback", params=p).json()}  # noqa: E731
    assert ids() == {fa["id"], fb["id"]}
    assert ids(kind="bug") == {fb["id"]}
    assert ids(status="new") == {fa["id"], fb["id"]}
    assert ids(status="done") == set()
    assert ids(q="deckung") == {fa["id"]}
    assert ids(q="%") == set()  # Wildcards werden maskiert
    assert vw.get(f"/projects/{pid}/feedback", params={"status": "bogus"}).status_code == 422

    # Betrachter darf Status nicht ändern, Editor schon
    assert vw.patch(f"/projects/{pid}/feedback/{fa['id']}", json={"status": "done"}).status_code == 403
    r = ed.patch(f"/projects/{pid}/feedback/{fa['id']}", json={"status": "doing", "note": " läuft "})
    assert r.status_code == 200
    assert (r.json()["status"], r.json()["note"], r.json()["handled_by"]) == ("doing", "läuft", w["eid"])
    assert ed.patch(f"/projects/{pid}/feedback/{fa['id']}", json={"status": "new"}).json()["handled_by"] is None
    assert ed.patch(f"/projects/{pid}/feedback/{fa['id']}", json={"status": "weird"}).status_code == 422
    assert ed.patch(f"/projects/{pid}/feedback/{A32}", json={"status": "done"}).status_code == 404

    # zu Aufgabe machen: Editor; Verknüpfung, Status wechselt, nur einmal
    assert vw.post(f"/projects/{pid}/feedback/{fa['id']}/to-task").status_code == 403
    r = ed.post(f"/projects/{pid}/feedback/{fa['id']}/to-task")
    assert r.status_code == 201, r.text
    res = r.json()
    assert res["task"]["title"] == "Idee A" and res["task"]["doc_id"] == d_pub["id"]
    assert "mehr Deckung" in res["task"]["description"] and res["task"]["status"] == "open"
    assert res["feedback"]["task_id"] == res["task"]["id"] and res["feedback"]["status"] == "doing"
    assert ed.post(f"/projects/{pid}/feedback/{fa['id']}/to-task").status_code == 409
    assert any(t["id"] == res["task"]["id"] for t in ed.get(f"/projects/{pid}/tasks").json())
    # Aufgabe gelöscht -> Verknüpfung entfällt, erneutes Umwandeln möglich
    assert ed.delete(f"/projects/{pid}/tasks/{res['task']['id']}").status_code == 200
    assert next(f for f in ed.get(f"/projects/{pid}/feedback").json() if f["id"] == fa["id"])["task_id"] is None
    assert ed.post(f"/projects/{pid}/feedback/{fa['id']}/to-task").status_code == 201
    # Missionsbau-Bezug wird von einem Editor ohne Builder-Recht nicht in die Aufgabe übernommen
    r = ed.post(f"/projects/{pid}/feedback/{fb['id']}/to-task")
    assert r.status_code == 201 and r.json()["task"]["doc_id"] is None

    # Löschen nur Owner
    assert ed.delete(f"/projects/{pid}/feedback/{fa['id']}").status_code == 403
    assert b.delete(f"/projects/{pid}/feedback/{fa['id']}").status_code == 200
    assert ids() == {fb["id"]}
    # Datei weg -> Bezug entfällt
    assert b.delete(f"/projects/{pid}/docs/{d_sec['id']}").status_code == 200
    assert b.get(f"/projects/{pid}/feedback").json()[0]["doc_id"] is None
    # archiviert: Schreiben gesperrt
    assert b.patch(f"/projects/{pid}", json={"archived": True}).status_code == 200
    assert vw.post(f"/projects/{pid}/feedback", json={"title": "x"}).status_code == 403


# ─── Status & Meilensteine ─────────────────────────────────────────────────

def test_stage_and_milestones(world):
    w = world
    pid, b, ed, vw = w["pid"], w["builder"], w["ed"], w["vw"]
    assert b.get(f"/projects/{pid}").json()["stage"] == "draft"
    assert vw.patch(f"/projects/{pid}", json={"stage": "review"}).status_code == 403
    r = ed.patch(f"/projects/{pid}", json={"stage": "review"})
    assert r.status_code == 200 and r.json()["stage"] == "review"
    assert ed.patch(f"/projects/{pid}", json={"stage": "bogus"}).status_code == 422
    # Editor darf sonst nichts am Projekt ändern
    assert ed.patch(f"/projects/{pid}", json={"name": "Neu"}).status_code == 403
    assert ed.patch(f"/projects/{pid}", json={"stage": "test", "archived": True}).status_code == 403
    assert b.patch(f"/projects/{pid}", json={"stage": "test", "description": "d"}).json()["stage"] == "test"
    assert next(p for p in vw.get("/projects").json() if p["id"] == pid)["stage"] == "test"

    ov = vw.get(f"/projects/{pid}/overview").json()
    assert ov["stage"] == "test" and ov["feedback_new"] == 0
    assert ov["milestones"] == {"open": 0, "done": 0, "overdue": 0, "next": None}

    # CRUD
    assert vw.post(f"/projects/{pid}/milestones", json={"title": "x"}).status_code == 403
    m1 = ed.post(f"/projects/{pid}/milestones", json={"title": "Alpha", "due_date": "2999-05-01"}).json()
    m2 = ed.post(f"/projects/{pid}/milestones", json={"title": "Beta", "due_date": "2999-03-01"}).json()
    m3 = ed.post(f"/projects/{pid}/milestones", json={"title": "Alt", "due_date": "2000-01-01"}).json()
    m4 = ed.post(f"/projects/{pid}/milestones", json={"title": "Ohne Termin"}).json()
    assert m1 == {"id": m1["id"], "title": "Alpha", "due_date": "2999-05-01", "done": False, "ordering": 0}
    assert m4["due_date"] is None and m4["ordering"] == 3
    assert ed.post(f"/projects/{pid}/milestones", json={"title": "", "due_date": "kaputt"}).status_code == 422
    assert [m["title"] for m in vw.get(f"/projects/{pid}/milestones").json()] == ["Alpha", "Beta", "Alt", "Ohne Termin"]
    assert w["out"].get(f"/projects/{pid}/milestones").status_code == 404

    ov = vw.get(f"/projects/{pid}/overview").json()
    assert ov["milestones"] == {"open": 4, "done": 0, "overdue": 1,
                                "next": {"id": m2["id"], "title": "Beta", "due_date": "2999-03-01"}}
    r = ed.patch(f"/projects/{pid}/milestones/{m2['id']}", json={"done": True, "title": "Beta 2"})
    assert r.status_code == 200 and r.json()["done"] is True and r.json()["title"] == "Beta 2"
    assert vw.patch(f"/projects/{pid}/milestones/{m2['id']}", json={"done": False}).status_code == 403
    ed.patch(f"/projects/{pid}/milestones/{m4['id']}", json={"due_date": "2999-04-01", "ordering": 9})
    assert ed.patch(f"/projects/{pid}/milestones/{m4['id']}", json={"done": True}).json()["due_date"] == "2999-04-01"
    assert ed.patch(f"/projects/{pid}/milestones/{m4['id']}", json={"due_date": None}).json()["due_date"] is None
    assert ed.patch(f"/projects/{pid}/milestones/{m1['id']}", json={"title": " "}).status_code == 400
    ov = vw.get(f"/projects/{pid}/overview").json()
    assert ov["milestones"]["open"] == 2 and ov["milestones"]["done"] == 2
    assert ov["milestones"]["next"]["title"] == "Alpha"

    assert vw.delete(f"/projects/{pid}/milestones/{m3['id']}").status_code == 403
    assert ed.delete(f"/projects/{pid}/milestones/{m3['id']}").status_code == 200
    assert ed.delete(f"/projects/{pid}/milestones/{m3['id']}").status_code == 404
    assert ed.patch(f"/projects/{pid}/milestones/{A32}", json={"done": True}).status_code == 404

    # feedback_new zählt nur Status new
    f = vw.post(f"/projects/{pid}/feedback", json={"title": "n"}).json()
    vw.post(f"/projects/{pid}/feedback", json={"title": "m"})
    assert vw.get(f"/projects/{pid}/overview").json()["feedback_new"] == 2
    ed.patch(f"/projects/{pid}/feedback/{f['id']}", json={"status": "done"})
    assert vw.get(f"/projects/{pid}/overview").json()["feedback_new"] == 1


# ─── Dokument-Kommentare ───────────────────────────────────────────────────

def test_doc_comments(world):
    w = world
    pid, b, ed, vw = w["pid"], w["builder"], w["ed"], w["vw"]
    d = _doc(ed, pid, "Brief", "inhalt")
    secret = _doc(b, pid, "Geheim", "x", space="builder")
    base = f"/projects/{pid}/docs/{d['id']}/comments"

    r = vw.post(base, json={"text": "  Frage dazu @" + "t" + "?  "})  # Betrachter darf kommentieren
    assert r.status_code == 201, r.text
    c = r.json()
    assert c["text"] == "Frage dazu @t?" and c["user_id"] == w["vid"] and c["can_edit"] and c["can_delete"]
    assert c["doc_id"] == d["id"] and c["edited_at"] is None
    assert vw.post(base, json={"text": "   "}).status_code in (400, 422)
    assert w["out"].post(base, json={"text": "x"}).status_code == 404
    assert w["out"].get(base).status_code == 404

    # Erwähnung wird aufgelöst
    me = w["builder"].get("/auth/me").json()["username"]
    c2 = ed.post(base, json={"text": f"@{me} bitte prüfen"}).json()
    assert [m["type"] for m in c2["mentions"]] == ["user"] and c2["mentions"][0]["id"] is not None
    lst = vw.get(base).json()
    assert [x["id"] for x in lst] == [c["id"], c2["id"]]
    assert lst[0]["can_edit"] and not lst[1]["can_edit"] and not lst[1]["can_delete"]

    # Bearbeiten nur eigene; Löschen eigene oder Owner
    assert ed.patch(f"{base}/{c['id']}", json={"text": "fremd"}).status_code == 403
    r = vw.patch(f"{base}/{c['id']}", json={"text": "geändert"})
    assert r.status_code == 200 and r.json()["text"] == "geändert" and r.json()["edited_at"]
    assert vw.delete(f"{base}/{c2['id']}").status_code == 403
    assert w["builder"].delete(f"{base}/{c2['id']}").status_code == 200  # Owner
    assert vw.delete(f"{base}/{c['id']}").status_code == 200
    assert vw.delete(f"{base}/{c['id']}").status_code == 404

    # Missionsbau-Datei: nur für Missionsbauer
    sb = f"/projects/{pid}/docs/{secret['id']}/comments"
    assert vw.get(sb).status_code == 404 and vw.post(sb, json={"text": "x"}).status_code == 404
    assert ed.get(sb).status_code == 404
    assert b.post(sb, json={"text": "intern"}).status_code == 201
    assert len(b.get(sb).json()) == 1
    # Kommentar der falschen Datei / falsches Projekt
    other = _doc(ed, pid, "Andere", "z")
    cc = ed.post(base, json={"text": "k"}).json()
    assert ed.patch(f"/projects/{pid}/docs/{other['id']}/comments/{cc['id']}", json={"text": "q"}).status_code == 404
    # Ordner: keine Kommentare
    fo = b.post(f"/projects/{pid}/docs", json={"space": "public", "kind": "folder", "name": "F"}).json()
    assert ed.get(f"/projects/{pid}/docs/{fo['id']}/comments").status_code == 400
    # Datei löschen räumt Kommentare auf
    from app.db import SessionLocal
    from app.models import DocComment

    assert ed.delete(f"/projects/{pid}/docs/{d['id']}").status_code == 200
    with SessionLocal() as db:
        assert db.query(DocComment).filter(DocComment.doc_id == d["id"]).count() == 0


# ─── Dokument-Versionen ────────────────────────────────────────────────────

def _versions(c, pid, did):
    r = c.get(f"/projects/{pid}/docs/{did}/versions")
    assert r.status_code == 200, r.text
    return r.json()


def _age(did, minutes):
    """Alle Versionen der Datei künstlich altern lassen (5-Minuten-Regel)."""
    from app.db import SessionLocal
    from app.models import ProjectDocVersion

    with SessionLocal() as db:
        for v in db.query(ProjectDocVersion).filter(ProjectDocVersion.doc_id == did):
            v.created_at = v.created_at - timedelta(minutes=minutes)
        db.commit()


def test_doc_versions(world):
    w = world
    pid, b, ed, vw = w["pid"], w["builder"], w["ed"], w["vw"]
    d = _doc(ed, pid, "Brief", "v1")
    did = d["id"]
    url = f"/projects/{pid}/docs/{did}"
    assert _versions(vw, pid, did) == []

    # erste Änderung sichert den vorherigen Stand
    assert ed.patch(url, json={"content": "v2"}).status_code == 200
    vs = _versions(vw, pid, did)
    assert len(vs) == 1 and vs[0]["name"] == "Brief" and vs[0]["saved_by"] == w["eid"] and vs[0]["byte_size"] == 2
    assert "content" not in vs[0]
    # gleicher Nutzer innerhalb von 5 Minuten: keine weitere Version
    assert ed.patch(url, json={"content": "v3"}).status_code == 200
    assert len(_versions(vw, pid, did)) == 1
    # unveränderter Inhalt / reine Umbenennung: nichts
    ed.patch(url, json={"content": "v3"})
    ed.patch(url, json={"name": "Brief 2"})
    assert len(_versions(vw, pid, did)) == 1
    # anderer Nutzer: eigene Version (Stand v3, Name zum Zeitpunkt)
    assert b.patch(url, json={"content": "v4"}).status_code == 200
    vs = _versions(vw, pid, did)
    assert [v["saved_by"] for v in vs] == [w["builder"].get("/auth/me").json()["id"], w["eid"]]
    v3 = vs[0]
    assert v3["name"] == "Brief 2"
    assert vw.get(f"{url}/versions/{v3['id']}").json()["content"] == "v3"
    # nach > 5 Minuten wieder
    _age(did, 6)
    assert b.patch(url, json={"content": "v5"}).status_code == 200
    assert len(_versions(vw, pid, did)) == 3

    # Rechte / Fehler
    assert w["out"].get(f"{url}/versions").status_code == 404
    assert vw.get(f"{url}/versions/{A32}").status_code == 404
    other = _doc(ed, pid, "Andere", "o1")
    assert ed.get(f"/projects/{pid}/docs/{other['id']}/versions/{v3['id']}").status_code == 404
    assert vw.post(f"{url}/versions/{v3['id']}/restore").status_code == 403

    # Wiederherstellen: Inhalt zurück, aktueller Stand wird gesichert (auch ohne 5-Minuten-Abstand)
    n = len(_versions(vw, pid, did))
    r = ed.post(f"{url}/versions/{v3['id']}/restore")
    assert r.status_code == 200, r.text
    assert r.json()["content"] == "v3" and r.json()["name"] == "Brief 2"
    assert ed.get(url).json()["content"] == "v3"
    vs = _versions(vw, pid, did)
    assert len(vs) == n + 1
    assert vw.get(f"{url}/versions/{vs[0]['id']}").json()["content"] == "v5"
    # Wiederherstellen aktualisiert Verweis-Index / Zeitleiste (Inhalt wirkt wie ein Speichern)
    d2 = _doc(ed, pid, "Zeit", "## 06:30 Start\n")
    ed.patch(f"/projects/{pid}/docs/{d2['id']}", json={"content": "kein Titel"})
    v = _versions(ed, pid, d2["id"])[0]
    assert ed.get(f"/projects/{pid}/timeline").json() == []
    assert ed.post(f"/projects/{pid}/docs/{d2['id']}/versions/{v['id']}/restore").status_code == 200
    assert [r["heading"] for r in ed.get(f"/projects/{pid}/timeline").json()] == ["Start"]

    # Missionsbau-Datei: Versionen nur für Missionsbauer
    sec = _doc(b, pid, "Geheim", "s1", space="builder")
    b.patch(f"/projects/{pid}/docs/{sec['id']}", json={"content": "s2"})
    assert len(_versions(b, pid, sec["id"])) == 1
    assert vw.get(f"/projects/{pid}/docs/{sec['id']}/versions").status_code == 404
    assert ed.post(f"/projects/{pid}/docs/{sec['id']}/versions/{A32}/restore").status_code == 404
    # archiviert: Wiederherstellen gesperrt
    assert b.patch(f"/projects/{pid}", json={"archived": True}).status_code == 200
    assert ed.post(f"{url}/versions/{v3['id']}/restore").status_code == 403


def test_doc_versions_limit_and_cleanup(world):
    w = world
    pid, ed = w["pid"], w["ed"]
    d = _doc(ed, pid, "Lang", "start")
    did = d["id"]
    from app.db import SessionLocal
    from app.models import ProjectDocVersion

    for i in range(55):
        assert ed.patch(f"/projects/{pid}/docs/{did}", json={"content": f"stand {i}"}).status_code == 200
        _age(did, 6)
    vs = _versions(ed, pid, did)
    assert len(vs) == 50
    contents = [ed.get(f"/projects/{pid}/docs/{did}/versions/{v['id']}").json()["content"] for v in vs]
    assert contents[0] == "stand 53" and contents[-1] == "stand 4"  # älteste fielen weg
    # leere Stände werden nicht gesichert
    e = _doc(ed, pid, "Leer", "")
    ed.patch(f"/projects/{pid}/docs/{e['id']}", json={"content": "jetzt Text"})
    assert _versions(ed, pid, e["id"]) == []
    # Datei löschen räumt Versionen auf
    assert ed.delete(f"/projects/{pid}/docs/{did}").status_code == 200
    with SessionLocal() as db:
        assert db.query(ProjectDocVersion).filter(ProjectDocVersion.doc_id == did).count() == 0


def test_project_delete_cleans_up(world):
    w = world
    pid, b = w["pid"], w["builder"]
    d = _doc(b, pid, "D", "a")
    b.patch(f"/projects/{pid}/docs/{d['id']}", json={"content": "b"})
    b.post(f"/projects/{pid}/docs/{d['id']}/comments", json={"text": "c"})
    b.post(f"/projects/{pid}/milestones", json={"title": "M"})
    b.post(f"/projects/{pid}/feedback", json={"title": "F"})
    assert b.delete(f"/projects/{pid}").status_code == 200
    from app.db import SessionLocal
    from app.models import DocComment, ProjectDocVersion, ProjectFeedback, ProjectMilestone

    with SessionLocal() as db:
        for m, col in ((DocComment, DocComment.project_id), (ProjectDocVersion, ProjectDocVersion.project_id),
                       (ProjectFeedback, ProjectFeedback.project_id), (ProjectMilestone, ProjectMilestone.project_id)):
            assert db.query(m).filter(col == pid).count() == 0
