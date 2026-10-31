"""Brücke zu Discord & Co.: Codes, Verknüpfung, Ein- und Ausgang."""
import itertools

from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app

PW = "pw-1234567890"
_n = itertools.count(1)
BOT = {"Authorization": "Bearer bridge-test-token"}


def _user(admin, name):
    r = admin.post("/api/admin/users", json={"username": name, "password": PW, "role": "user"})
    assert r.status_code == 201, r.text
    c = TestClient(app)
    assert c.post("/auth/login", json={"username": name, "password": PW}).status_code == 200
    return c, r.json()["id"]


def test_bridge_roundtrip(admin, monkeypatch):
    monkeypatch.setattr(get_settings(), "bridge_token", "bridge-test-token")
    k = next(_n)
    (a, aid), (b, bid) = _user(admin, f"br{k}a"), _user(admin, f"br{k}b")
    assert a.get("/bridge/me").json()["enabled"] is True
    assert TestClient(app).get("/bridge/outbox", params={"provider": "discord"}).status_code == 401

    g = a.post("/chat/conversations", json={"kind": "group", "name": "Bruecke", "member_ids": [bid]}).json()
    assert b.post("/bridge/code", json={"kind": "conv", "conversation_id": g["id"]}).status_code == 403  # nur Ersteller
    code = a.post("/bridge/code", json={"kind": "conv", "conversation_id": g["id"]}).json()["code"]

    bot = TestClient(app)
    # Kanal verbinden (zweiter Versuch mit demselben Code scheitert)
    r = bot.post("/bridge/claim", headers=BOT, json={"provider": "discord", "code": code, "author_id": "d1", "channel_id": "chan1"})
    assert r.status_code == 200 and r.json()["kind"] == "conv"
    r2 = bot.post("/bridge/claim", headers=BOT, json={"provider": "discord", "code": code, "author_id": "d1", "channel_id": "chan2"})
    assert r2.status_code == 404
    assert bot.get("/bridge/links", headers=BOT, params={"provider": "discord"}).json() == ["chan1"]

    # Gast aus Discord -> erscheint im Chat, ohne Konto
    r = bot.post("/bridge/inbound", headers=BOT, json={"provider": "discord", "channel_id": "chan1", "author_id": "x9",
                                                       "author_name": "Fremder", "text": "Hallo vom Handy"})
    assert r.status_code == 200
    r = bot.post("/bridge/inbound", headers=BOT, json={"provider": "discord", "channel_id": "nope", "author_id": "x9",
                                                       "author_name": "F", "text": "x"})
    assert r.status_code == 404
    msgs = b.get(f"/chat/conversations/{g['id']}/messages").json()
    assert msgs[-1]["user_label"] == "Fremder (Discord)" and msgs[-1]["user_id"] is None
    assert b.get("/chat/unread").json()["chats"] == 1  # Gast-Nachricht zählt als ungelesen
    # Echo-Schutz: Eingehendes geht nicht zurück nach Discord
    assert bot.get("/bridge/outbox", headers=BOT, params={"provider": "discord"}).json() == []

    # Konto verknüpfen -> Nachricht kommt unter dem echten Konto
    ucode = b.post("/bridge/code", json={"kind": "user"}).json()["code"]
    r = bot.post("/bridge/claim", headers=BOT, json={"provider": "discord", "code": ucode, "author_id": "d2"})
    assert r.json()["kind"] == "user"
    bot.post("/bridge/inbound", headers=BOT, json={"provider": "discord", "channel_id": "chan1", "author_id": "d2",
                                                   "author_name": "BDisc", "text": "Ich bin da"})
    last = a.get(f"/chat/conversations/{g['id']}/messages").json()[-1]
    assert last["user_id"] == bid and last["origin"] == "discord"

    # Web -> Discord über die Outbox
    a.post(f"/chat/conversations/{g['id']}/messages", json={"text": "Antwort von der Seite"})
    out = bot.get("/bridge/outbox", headers=BOT, params={"provider": "discord"}).json()
    assert [(o["channel_id"], o["text"]) for o in out] == [("chan1", "Antwort von der Seite")]
    assert bot.post("/bridge/outbox/ack", headers=BOT, json={"ids": [o["id"] for o in out]}).status_code == 200
    assert bot.get("/bridge/outbox", headers=BOT, params={"provider": "discord"}).json() == []

    # Konto-ID gehört schon jemand anderem
    code2 = a.post("/bridge/code", json={"kind": "user"}).json()["code"]
    r = bot.post("/bridge/claim", headers=BOT, json={"provider": "discord", "code": code2, "author_id": "d2"})
    assert r.status_code == 409
    # Verbindung lösen
    link = a.get(f"/bridge/conversations/{g['id']}/links").json()[0]
    assert a.delete(f"/bridge/links/{link['id']}").status_code == 200


def test_admin_links_channel_from_snapshot(admin, monkeypatch):
    monkeypatch.setattr(get_settings(), "bridge_token", "bridge-test-token")
    k = next(_n)
    (a, aid), (b, bid) = _user(admin, f"br{k}c"), _user(admin, f"br{k}d")
    g = a.post("/chat/conversations", json={"kind": "group", "name": f"AdminLink{k}", "member_ids": [bid]}).json()
    bot = TestClient(app)
    snap = {"provider": "discord", "channels": [
        {"id": f"c{k}1", "name": "allgemein", "group_id": "s1", "group_name": "MDC"},
        {"id": f"c{k}2", "name": "ops", "group_id": "s1", "group_name": "MDC"}]}
    assert bot.post("/bridge/channels", json=snap).status_code == 401
    assert bot.post("/bridge/channels", headers=BOT, json=snap).json()["count"] == 2

    assert b.get("/bridge/admin/overview").status_code == 403  # nur Admin
    ov = admin.get("/bridge/admin/overview").json()
    assert {c["external_id"] for c in ov["channels"]} >= {f"c{k}1", f"c{k}2"}
    assert any(c["id"] == g["id"] for c in ov["conversations"])

    r = admin.post("/bridge/admin/links", json={"conversation_id": g["id"], "provider": "discord", "external_id": f"c{k}1"})
    assert r.status_code == 201, r.text
    assert admin.post("/bridge/admin/links", json={"conversation_id": g["id"], "provider": "discord",
                                                   "external_id": f"c{k}1"}).status_code == 409
    assert admin.post("/bridge/admin/links", json={"conversation_id": g["id"], "provider": "discord",
                                                   "external_id": "unbekannt"}).status_code == 400
    # Verbindung wirkt wie eine per Code erzeugte; Kanalname erscheint im Chat
    assert bot.get("/bridge/links", headers=BOT, params={"provider": "discord"}).json().count(f"c{k}1") == 1
    assert a.get(f"/bridge/conversations/{g['id']}/links").json()[0]["channel_name"] == "allgemein"
    # Kanal verschwindet aus der Momentaufnahme -> nicht mehr wählbar
    bot.post("/bridge/channels", headers=BOT, json={"provider": "discord", "channels": snap["channels"][:1]})
    assert f"c{k}2" not in {c["external_id"] for c in admin.get("/bridge/admin/overview").json()["channels"]}
    lid = admin.get("/bridge/admin/overview").json()["links"][0]["id"]
    assert admin.delete(f"/bridge/admin/links/{lid}").status_code == 200
