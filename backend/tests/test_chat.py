"""Chat, Gruppen-Chats, Erwähnungen und System-Feed."""
import itertools

from fastapi.testclient import TestClient

from app.main import app

PW = "pw-1234567890"
_n = itertools.count(1)


def _user(admin, name):
    r = admin.post("/api/admin/users", json={"username": name, "password": PW, "role": "user"})
    assert r.status_code == 201, r.text
    c = TestClient(app)
    assert c.post("/auth/login", json={"username": name, "password": PW}).status_code == 200
    return c, r.json()["id"]


def _trio(admin):
    k = next(_n)
    return [_user(admin, f"chat{k}{x}") for x in "abc"], k


def test_dm_and_unread(admin):
    ((a, aid), (b, bid), (c, cid)), k = _trio(admin)
    conv = a.post("/chat/conversations", json={"kind": "dm", "user_id": bid}).json()
    # get-or-create: gleiche Unterhaltung von der anderen Seite
    assert b.post("/chat/conversations", json={"kind": "dm", "user_id": aid}).json()["id"] == conv["id"]
    assert conv["name"].startswith(f"chat{k}b")
    assert c.get(f"/chat/conversations/{conv['id']}/messages").status_code == 404  # Dritte sehen nichts

    assert a.post(f"/chat/conversations/{conv['id']}/messages", json={"text": "Hallo"}).status_code == 201
    assert b.get("/chat/unread").json()["chats"] == 1
    assert a.get("/chat/unread").json()["chats"] == 0
    msgs = b.get(f"/chat/conversations/{conv['id']}/messages").json()
    assert [m["text"] for m in msgs] == ["Hallo"] and not msgs[0]["mine"]
    assert b.post(f"/chat/conversations/{conv['id']}/read").status_code == 200
    assert b.get("/chat/unread").json()["chats"] == 0

    # nur eigene Nachrichten bearbeiten/löschen
    mid = msgs[0]["id"]
    assert b.patch(f"/chat/conversations/{conv['id']}/messages/{mid}", json={"text": "x"}).status_code == 403
    assert a.patch(f"/chat/conversations/{conv['id']}/messages/{mid}", json={"text": "Hi"}).json()["edited_at"]
    assert a.delete(f"/chat/conversations/{conv['id']}/messages/{mid}").status_code == 200
    # nicht mit sich selbst
    assert a.post("/chat/conversations", json={"kind": "dm", "user_id": aid}).status_code == 400


def test_group_chat_mentions_and_system_feed(admin):
    ((a, aid), (b, bid), (c, cid)), k = _trio(admin)
    g = a.post("/chat/conversations", json={"kind": "group", "name": "Team", "member_ids": [bid]}).json()
    assert g["member_count"] == 2
    assert c.get(f"/chat/conversations/{g['id']}/messages").status_code == 404
    # Mitglieder verwalten: nur Ersteller
    assert b.put(f"/chat/conversations/{g['id']}/members", json={"add": [cid]}).status_code == 403
    assert len(a.put(f"/chat/conversations/{g['id']}/members", json={"add": [cid]}).json()) == 3

    cands = a.get(f"/chat/conversations/{g['id']}/mentionables").json()
    bh = next(x["handle"] for x in cands if x["id"] == bid)
    a.post(f"/chat/conversations/{g['id']}/messages", json={"text": f"@{bh} schau mal"})
    notes = b.get("/chat/notifications").json()
    assert len(notes) == 1 and notes[0]["kind"] == "chat_mention" and notes[0]["conversation_id"] == g["id"] and not notes[0]["read"]
    assert c.get("/chat/notifications").json() == []  # nur die Erwähnten
    assert b.get("/chat/unread").json()["notifications"] == 1
    b.post("/chat/notifications/read", json={"all": True})
    assert b.get("/chat/unread").json()["notifications"] == 0
    assert b.delete("/chat/notifications").status_code == 200
    assert b.get("/chat/notifications").json() == []

    # Austreten
    assert c.post(f"/chat/conversations/{g['id']}/leave").status_code == 200
    assert c.get(f"/chat/conversations/{g['id']}/messages").status_code == 404


def test_group_source_and_task_notifications(admin):
    ((a, aid), (b, bid), (c, cid)), k = _trio(admin)
    gid = admin.post("/api/admin/groups", json={"name": f"Squad{k}"}).json()["id"]
    r = admin.put(f"/api/admin/groups/{gid}/members", json=[aid, bid])
    assert r.status_code == 200, r.text
    # Chat aus bestehender Admin-Gruppe: Mitglieder kommen automatisch
    conv = a.post("/chat/conversations", json={"kind": "group", "source_type": "group", "source_id": gid}).json()
    assert conv["name"] == f"Squad{k}" and conv["member_count"] == 2
    assert c.post("/chat/conversations", json={"kind": "group", "source_type": "group", "source_id": gid}).status_code == 400
    assert b.get("/chat/conversations").json()[0]["id"] == conv["id"]

    # Projekt + Aufgabe: @gruppe im Thread benachrichtigt die Gruppenmitglieder mit Projektzugriff
    pid = admin.post("/projects", json={"name": f"P{k}"}).json()["id"]
    admin.put(f"/projects/{pid}/members", json=[
        {"subject_type": "user", "subject_id": aid, "role": "owner"},
        {"subject_type": "user", "subject_id": bid, "role": "viewer"},
        {"subject_type": "user", "subject_id": cid, "role": "viewer"},
    ])
    tid = a.post(f"/projects/{pid}/tasks", json={"title": "Aufgabe", "assignee_id": cid}).json()["id"]
    assert [n["kind"] for n in c.get("/chat/notifications").json()] == []  # Anlegen mit Zuständigem ist keine Zuweisung
    a.patch(f"/projects/{pid}/tasks/{tid}", json={"assignee_id": bid})
    assert [n["kind"] for n in b.get("/chat/notifications").json()] == ["assigned"]
    a.post(f"/projects/{pid}/tasks/{tid}/comments", json={"text": f"@Squad{k} bitte prüfen, @projekt zur Info"})
    kinds_b = [n["kind"] for n in b.get("/chat/notifications").json()]
    assert kinds_b.count("task_mention") == 1  # eine Benachrichtigung je Empfänger-Ereignis
    assert [n["kind"] for n in c.get("/chat/notifications").json()] == ["task_mention"]  # via @projekt
    assert a.get("/chat/notifications").json() == []  # Autor nie
    n = b.get("/chat/notifications").json()[0]
    assert n["project_id"] == pid and n["title"] == "Aufgabe"
