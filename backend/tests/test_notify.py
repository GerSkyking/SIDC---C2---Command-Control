"""Externe Benachrichtigungskanäle: Anlegen, Geheimnisse, SSRF-Schutz, Zustellung, Antworten aus dem Feed."""
import itertools

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.main import app
from app.services import channels as ch
from app.services import dispatcher

PW = "pw-1234567890"
_n = itertools.count(1)
HOOK = "https://discord.com/api/webhooks/123456789/abc-DEF_ghi"


def _user(admin, name):
    r = admin.post("/api/admin/users", json={"username": name, "password": PW, "role": "user"})
    assert r.status_code == 201, r.text
    c = TestClient(app)
    assert c.post("/auth/login", json={"username": name, "password": PW}).status_code == 200
    return c, r.json()["id"]


def test_channel_crud_and_secret_masking(admin):
    c, _ = _user(admin, f"nt{next(_n)}a")
    types = {t["type"] for t in c.get("/notify/types").json()["types"]}
    assert {"discord", "ntfy", "gotify", "matrix", "webhook", "email", "webpush"} <= types

    assert c.post("/notify/channels", json={"type": "discord", "config": {"url": "https://example.org/x"}}).status_code == 400
    r = c.post("/notify/channels", json={"type": "discord", "name": "Team", "config": {"url": HOOK}, "kinds": ["assigned"]})
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["config"]["url"] == "" and out["config"]["_set"] == ["url"]  # Geheimnis nie zurück
    assert HOOK not in str(c.get("/notify/channels").json())
    # in der DB verschlüsselt
    from app.models import NotificationChannel
    with SessionLocal() as db:
        raw = db.get(NotificationChannel, out["id"]).config["url"]
    assert raw.startswith("enc:") and HOOK not in raw

    # Patch ohne neues Geheimnis behält das alte
    assert c.patch(f"/notify/channels/{out['id']}", json={"config": {"url": ""}, "enabled": False}).json()["enabled"] is False
    assert c.delete(f"/notify/channels/{out['id']}").status_code == 200
    assert c.get("/notify/channels").json() == []


def test_other_user_cannot_touch_channel(admin):
    a, _ = _user(admin, f"nt{next(_n)}b")
    b, _ = _user(admin, f"nt{next(_n)}c")
    cid = a.post("/notify/channels", json={"type": "ntfy", "config": {"topic": "t"}}).json()["id"]
    assert b.delete(f"/notify/channels/{cid}").status_code == 404
    assert b.post(f"/notify/channels/{cid}/test").status_code == 404


def test_ssrf_blocked():
    for url in ("http://127.0.0.1:6379/", "http://localhost/x", "http://169.254.169.254/latest", "ftp://example.org/"):
        try:
            ch.check_url(url)
        except ch.ChannelError:
            continue
        raise AssertionError(url)


def test_dispatch_and_reply(admin, monkeypatch):
    (a, aid), (b, bid) = _user(admin, f"nt{next(_n)}d"), _user(admin, f"nt{next(_n)}e")
    sent = []
    monkeypatch.setattr(ch, "send_to", lambda t, cfg, m: sent.append((t, m)))
    b.post("/notify/channels", json={"type": "ntfy", "config": {"topic": "geheim"}, "kinds": ["chat_mention"]})
    b.post("/notify/channels", json={"type": "webhook", "config": {"url": "https://example.org/h"}})

    conv = a.post("/chat/conversations", json={"kind": "dm", "user_id": bid}).json()
    # DM ohne Erwähnung erzeugt keine Benachrichtigung; eine Gruppe mit Erwähnung schon
    grp = a.post("/chat/conversations", json={"kind": "group", "name": "Team", "member_ids": [bid]}).json()
    cands = a.get(f"/chat/conversations/{grp['id']}/mentionables").json()
    bh = next(x["handle"] for x in cands if x["id"] == bid)
    assert a.post(f"/chat/conversations/{grp['id']}/messages", json={"text": f"Hi @{bh} komm mal"}).status_code == 201
    assert len(b.get("/chat/notifications").json()) == 1  # Erwähnung wurde aufgelöst
    with SessionLocal() as db:
        dispatcher.dispatch_pending(db)  # der Hintergrund-Task kann schneller gewesen sein – dann ist sent schon gefüllt
    assert {t for t, _ in sent} == {"ntfy", "webhook"}
    m = sent[0][1]
    assert m.kind == "chat_mention" and "erwähnt" in m.headline
    sent.clear()
    with SessionLocal() as db:
        assert dispatcher.dispatch_pending(db) == 0  # nichts doppelt

    # Antwort aus dem System-Feed landet im Chat und markiert gelesen
    note = b.get("/chat/notifications").json()[0]
    r = b.post(f"/chat/notifications/{note['id']}/reply", json={"text": "Bin da"})
    assert r.status_code == 201, r.text
    texts = [x["text"] for x in a.get(f"/chat/conversations/{grp['id']}/messages").json()]
    assert texts[-1] == "Bin da"
    assert b.get("/chat/notifications").json()[0]["read"] is True
    assert a.post(f"/chat/notifications/{note['id']}/reply", json={"text": "x"}).status_code == 404
    assert conv["id"]
