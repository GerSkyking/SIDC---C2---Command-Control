"""Opt-in-Benachrichtigungen (feedback_new, doc_mention): nur bei ausdrücklichem Kanal-Abo, sonst weder Feed noch Zustellung."""
import itertools

import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.main import app
from app.models import Notification
from app.services import channels as ch
from app.services import dispatcher

PW = "pw-1234567890"
_n = itertools.count(1)


def _user(admin, name, **flags):
    r = admin.post("/api/admin/users", json={"username": name, "password": PW, "role": "user", **flags})
    assert r.status_code == 201, r.text
    c = TestClient(app)
    assert c.post("/auth/login", json={"username": name, "password": PW}).status_code == 200
    return c, r.json()["id"]


@pytest.fixture
def world(admin, monkeypatch):
    k = next(_n)
    owner, oid = _user(admin, f"oi{k}a", is_mission_builder=True, can_create_plans=True)
    co, cid = _user(admin, f"oi{k}b")  # zweiter Owner, kein Missionsbauer
    ed, eid = _user(admin, f"oi{k}c", is_mission_builder=True)
    pid = owner.post("/projects", json={"name": "Op Optin"}).json()["id"]
    r = owner.put(f"/projects/{pid}/members", json=[
        {"subject_type": "user", "subject_id": oid, "role": "owner"},
        {"subject_type": "user", "subject_id": cid, "role": "owner"},
        {"subject_type": "user", "subject_id": eid, "role": "editor"},
    ])
    assert r.status_code == 200, r.text
    sent = []
    monkeypatch.setattr(ch, "send_to", lambda t, cfg, m: sent.append((t, m)))
    return dict(owner=owner, oid=oid, co=co, cid=cid, ed=ed, eid=eid, pid=pid, anon=TestClient(app), sent=sent)


def _chan(c, kinds):
    r = c.post("/notify/channels", json={"type": "ntfy", "config": {"topic": "t"}, "kinds": kinds})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _flush():
    with SessionLocal() as db:
        dispatcher.dispatch_pending(db)


def _count(uid, kind):
    with SessionLocal() as db:
        return db.query(Notification).filter(Notification.user_id == uid, Notification.kind == kind).count()


def _token(w):
    return w["owner"].post(f"/projects/{w['pid']}/feedback-token").json()["token"]


def test_kinds_validation(admin):
    c, _ = _user(admin, f"oi{next(_n)}v")
    kinds = c.get("/notify/types").json()
    assert {"feedback_new", "doc_mention"} <= set(kinds["kinds"]) and set(kinds["opt_in"]) == {"feedback_new", "doc_mention"}
    ok = c.post("/notify/channels", json={"type": "ntfy", "config": {"topic": "t"}, "kinds": ["assigned", "doc_mention"]})
    assert ok.status_code == 201 and ok.json()["kinds"] == ["assigned", "doc_mention"]
    assert c.post("/notify/channels", json={"type": "ntfy", "config": {"topic": "t"}, "kinds": ["bogus"]}).status_code == 422


def test_no_explicit_subscription_gets_nothing(world):
    w = world
    _chan(w["owner"], [])  # leer = nur Standard-Arten
    _chan(w["co"], ["assigned"])
    tok = _token(w)
    assert w["anon"].post(f"/api/public/feedback/{tok}", json={"title": "Hi", "kind": "idea"}).status_code == 201
    assert w["ed"].post(f"/projects/{w['pid']}/feedback", json={"title": "Intern"}).status_code == 201
    _flush()
    assert w["sent"] == []
    assert _count(w["oid"], "feedback_new") == 0 and _count(w["cid"], "feedback_new") == 0  # auch kein Feed-Eintrag
    assert w["owner"].get("/chat/notifications").json() == []


def test_feedback_new_internal_and_external(world):
    w = world
    _chan(w["owner"], ["feedback_new"])
    _chan(w["co"], ["feedback_new"])
    tok = _token(w)
    assert w["anon"].post(f"/api/public/feedback/{tok}", json={"title": "Von außen", "text": "x"}).status_code == 201
    _flush()
    heads = [m.headline for _, m in w["sent"]]
    assert len(heads) == 2 and all("Jemand von außen" in h and "Von außen" in h for h in heads)
    assert w["sent"][0][1].url == "" or w["sent"][0][1].url.endswith(f"/projects/{w['pid']}/feedback")
    w["sent"].clear()

    # Honeypot löst nichts aus
    w["anon"].post(f"/api/public/feedback/{tok}", json={"title": "Bot", "website": "http://spam"})
    _flush()
    assert w["sent"] == []

    # intern vom Owner: der Auslöser bekommt nichts, der zweite Owner schon
    assert w["owner"].post(f"/projects/{w['pid']}/feedback", json={"title": "Intern"}).status_code == 201
    _flush()
    assert len(w["sent"]) == 1
    assert _count(w["oid"], "feedback_new") == 1  # nur die externe Meldung von vorhin
    assert _count(w["cid"], "feedback_new") == 2
    assert "Intern" in w["sent"][0][1].headline


def test_doc_mention_rights(world):
    w = world
    pid = w["pid"]
    _chan(w["co"], ["doc_mention"])  # Nicht-Missionsbauer
    _chan(w["ed"], ["doc_mention"])  # Missionsbauer
    pub = w["owner"].post(f"/projects/{pid}/docs", json={"space": "public", "kind": "doc", "name": "Oeffentlich"}).json()
    bld = w["owner"].post(f"/projects/{pid}/docs", json={"space": "builder", "kind": "doc", "name": "Intern"}).json()
    cands = w["owner"].get(f"/projects/{pid}/mentionables").json()
    hco = next(x["handle"] for x in cands if x["id"] == w["cid"])
    hed = next(x["handle"] for x in cands if x["id"] == w["eid"])

    r = w["owner"].post(f"/projects/{pid}/docs/{pub['id']}/comments", json={"text": f"@{hco} @{hed} schau mal"})
    assert r.status_code == 201, r.text
    _flush()
    assert len(w["sent"]) == 2
    assert all("Oeffentlich" in m.headline for _, m in w["sent"])
    w["sent"].clear()

    # Missionsbau-Datei: der Nicht-Missionsbauer bekommt nichts
    r = w["owner"].post(f"/projects/{pid}/docs/{bld['id']}/comments", json={"text": f"@{hco} @{hed} intern"})
    assert r.status_code == 201, r.text
    _flush()
    assert len(w["sent"]) == 1 and "Intern" in w["sent"][0][1].headline
    assert _count(w["cid"], "doc_mention") == 1 and _count(w["eid"], "doc_mention") == 2
    w["sent"].clear()

    # Bearbeiten: nur neu hinzugekommene Erwähnungen; Selbst-Erwähnung zählt nicht
    cid_ = r.json()["id"]
    assert w["owner"].patch(f"/projects/{pid}/docs/{bld['id']}/comments/{cid_}",
                            json={"text": f"@{hed} intern, noch mal"}).status_code == 200
    _flush()
    assert w["sent"] == []
