"""Papierkorb: Admin/Techniker sehen alles, andere nur, was sie selbst gelöscht haben."""
from fastapi.testclient import TestClient

from app.main import app


def _login(name: str, pw: str) -> TestClient:
    c = TestClient(app)
    assert c.post("/auth/login", json={"username": name, "password": pw}).status_code == 200
    return c


def test_trash_visibility(admin):
    pw = "trash-test-pass-123"
    for n in ("trash_a", "trash_b"):
        assert admin.post("/api/admin/users", json={"username": n, "password": pw, "can_create_plans": True}).status_code == 201
    a, b = _login("trash_a", pw), _login("trash_b", pw)
    maps = admin.get("/api/maps").json() if admin.get("/api/maps").status_code == 200 else []
    map_id = maps[0]["id"] if maps else "m1"
    pa = a.post("/plans", json={"name": "A-Plan", "map_id": map_id}).json()["id"]
    pb = b.post("/plans", json={"name": "B-Plan", "map_id": map_id}).json()["id"]
    assert a.delete(f"/plans/{pa}").status_code == 200
    assert b.delete(f"/plans/{pb}").status_code == 200

    ids = lambda c: [p["id"] for p in c.get("/plans/trash").json()]  # noqa: E731
    assert ids(a) == [pa] and ids(b) == [pb]            # jeder nur das Eigene
    assert {pa, pb} <= set(ids(admin))                   # Admin sieht alles
    assert b.post(f"/plans/{pa}/undelete").status_code in (403, 404)  # fremdes nicht wiederherstellbar
    assert a.post(f"/plans/{pa}/undelete").status_code == 200
    assert admin.delete(f"/plans/{pb}/purge").status_code == 200
