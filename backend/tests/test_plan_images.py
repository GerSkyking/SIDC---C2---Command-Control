"""Plan-Bilder: Upload (BLOB), Auslieferung, Snapshot, WS-Edit, Admin, Public."""
import base64

# 2×2 rote PNG
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg=="
)
# 1×1 GIF89a
GIF = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")


def _make_map(admin):
    admin.post("/api/maps", json={"id": "m1", "name": "M1", "url": "http://x.invalid/a.zip"})
    from app.db import SessionLocal
    from app.models import Map, now

    with SessionLocal() as db:
        m = db.get(Map, "m1")
        m.status = "ready"
        m.imported_at = now()
        db.commit()


def _plan(admin):
    _make_map(admin)
    return admin.post("/plans", json={"name": "Bilder", "map_id": "m1"}).json()["id"]


def _upload(client, pid, data, ct="image/png", **params):
    return client.post(
        f"/plans/{pid}/images",
        params=params,
        content=data,
        headers={"content-type": ct, "x-filename": "test%20bild.png"},
    )


def test_upload_serve_snapshot(admin):
    pid = _plan(admin)
    r = _upload(admin, pid, PNG)
    assert r.status_code == 201, r.text
    img = r.json()
    assert img["content_type"] == "image/png"
    assert (img["natural_w"], img["natural_h"]) == (2, 2)
    assert img["byte_size"] == len(PNG)
    assert img["filename"] == "test bild.png"

    raw = admin.get(f"/plans/{pid}/images/{img['id']}/raw")
    assert raw.status_code == 200
    assert raw.content == PNG
    assert raw.headers["content-type"].startswith("image/png")

    snap = admin.get(f"/plans/{pid}/snapshot").json()
    assert [i["id"] for i in snap["images"]] == [img["id"]]
    assert "data" not in snap["images"][0]

    assert _upload(admin, pid, GIF, ct="image/gif").status_code == 201


def test_reject_bad_and_oversize(admin):
    pid = _plan(admin)
    assert _upload(admin, pid, b"not an image at all").status_code == 400
    from app.config import get_settings

    big = b"\x89PNG\r\n\x1a\n" + b"0" * (get_settings().image_max_mb * 1024 * 1024 + 10)
    assert _upload(admin, pid, big).status_code == 413


def test_builder_phase_requires_mission_builder(admin, client):
    pid = _plan(admin)
    phases = admin.get(f"/plans/{pid}/phases").json()
    builder_ph = next(p for p in phases if p["plane"] == "builder")

    # zweiter User ohne MB-Rolle, als Editor auf den Plan
    admin.post("/api/admin/users", json={"username": "ed", "password": "pw-1234567890", "role": "user"})
    uid = next(u["id"] for u in admin.get("/api/admin/users").json() if u["username"] == "ed")
    admin.put(f"/plans/{pid}/acl", json=[
        {"subject_type": "user", "subject_id": uid, "level": "editor"},
        {"subject_type": "user", "subject_id": admin.get("/auth/me").json()["id"], "level": "owner"},
    ])
    client.post("/auth/login", json={"username": "ed", "password": "pw-1234567890"})
    r = _upload(client, pid, PNG, phase_id=builder_ph["id"])
    assert r.status_code == 403


def test_admin_list_and_delete(admin):
    pid = _plan(admin)
    img = _upload(admin, pid, PNG).json()
    rows = admin.get("/api/admin/images").json()
    assert any(x["id"] == img["id"] and x["plan_name"] == "Bilder" for x in rows)
    assert admin.delete(f"/api/admin/images/{img['id']}").status_code == 200
    assert admin.get(f"/plans/{pid}/images/{img['id']}/raw").status_code == 404


def test_placement_multi_phase_reuse(admin):
    """Ein Bild lässt sich mehrfach (auch in mehreren Phasen) auf der Karte platzieren."""
    pid = _plan(admin)
    phases = admin.get(f"/plans/{pid}/phases").json()
    p1 = next(p for p in phases if p["plane"] == "player")
    p2 = admin.post(f"/plans/{pid}/phases", json={"name": "Phase 2"}).json()
    img = _upload(admin, pid, PNG).json()

    with admin.websocket_connect(f"/plans/{pid}/live") as ws:
        assert ws.receive_json()["type"] == "hello"
        assert ws.receive_json()["type"] == "presence.join"

        ws.send_json({
            "type": "placement.create", "cid": "pl1",
            "data": {"image_id": img["id"], "phase_id": p1["id"], "world_x": 1.0, "world_y": 2.0},
        })
        m1 = ws.receive_json()
        assert m1["type"] == "placement.upsert" and m1["cid"] == "pl1"
        pl1_id = m1["placement"]["id"]

        ws.send_json({
            "type": "placement.create", "cid": "pl2",
            "data": {"image_id": img["id"], "phase_id": p2["id"], "world_x": 3.0, "world_y": 4.0},
        })
        m2 = ws.receive_json()
        pl2_id = m2["placement"]["id"]
        assert pl2_id != pl1_id

        snap = admin.get(f"/plans/{pid}/snapshot").json()
        placements = {p["id"]: p for p in snap["image_placements"]}
        assert placements[pl1_id]["phase_id"] == p1["id"]
        assert placements[pl2_id]["phase_id"] == p2["id"]
        assert placements[pl1_id]["image_id"] == img["id"] == placements[pl2_id]["image_id"]
        # Metadaten (caption/note) bleiben ein einziges gemeinsames Bild, keine Duplikate.
        assert len(snap["images"]) == 1

        ws.send_json({"type": "placement.move", "id": pl1_id, "data": {"world_x": 9.0, "world_y": 9.0}})
        moved = ws.receive_json()["placement"]
        assert moved["world_x"] == 9.0

        ws.send_json({"type": "placement.delete", "id": pl1_id})
        assert ws.receive_json() == {"type": "placement.delete", "id": pl1_id}

    snap = admin.get(f"/plans/{pid}/snapshot").json()
    ids = {p["id"] for p in snap["image_placements"]}
    assert pl1_id not in ids and pl2_id in ids

    # Bild löschen räumt alle verbliebenen Platzierungen mit ab (CASCADE).
    with admin.websocket_connect(f"/plans/{pid}/live") as ws:
        assert ws.receive_json()["type"] == "hello"
        assert ws.receive_json()["type"] == "presence.join"
        ws.send_json({"type": "image.delete", "id": img["id"]})
        assert ws.receive_json() == {"type": "image.delete", "id": img["id"]}
    snap = admin.get(f"/plans/{pid}/snapshot").json()
    assert snap["images"] == [] and snap["image_placements"] == []


def test_public_share_phase_visibility(admin):
    pid = _plan(admin)
    p_player = next(p for p in admin.get(f"/plans/{pid}/phases").json() if p["plane"] == "player")
    p_other = admin.post(f"/plans/{pid}/phases", json={"name": "Verdeckt"}).json()
    hidden = _upload(admin, pid, PNG, phase_id=p_other["id"]).json()
    shown = _upload(admin, pid, PNG, phase_id=p_player["id"]).json()

    tok = admin.post(f"/plans/{pid}/shares", json={"phase_ids": [p_player["id"]]}).json()["token"]
    snap = admin.get(f"/public/plans/{tok}").json()
    ids = {i["id"] for i in snap["images"]}
    assert shown["id"] in ids and hidden["id"] not in ids
    assert admin.get(f"/public/plans/{tok}/images/{shown['id']}/raw").status_code == 200
    assert admin.get(f"/public/plans/{tok}/images/{hidden['id']}/raw").status_code == 404
