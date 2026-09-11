"""WebSocket-Endpoint pro Plan — autoritativer Server.

Client rendert Anlegen/Freihand optimistisch und schickt eine temporäre `cid`;
der Server bestätigt mit der echten ID (`marker.upsert` inkl. `cid`) oder lehnt
mit `reject` ab. Verschieben/Ändern/Löschen/Sperren laufen ausschließlich über den
Server und werden gegen Rechte + Marker-Lock geprüft.
"""
from __future__ import annotations

import logging

from sqlalchemy import select
from starlette.concurrency import run_in_threadpool
from starlette.websockets import WebSocket, WebSocketDisconnect

from ..db import SessionLocal
from ..models import Annotation, ImagePlacement, Marker, OrbatNode, Phase, Plan, PlanImage, Stroke, User, now
from ..sidc_status import status_from_sidc
from ..permissions import (
    effective_caps,
    effective_level,
    effective_mission_builder,
    rank,
)
from ..security import SESSION_COOKIE, origin_allowed, read_session
from ..services.realtime import hub

log = logging.getLogger("sidc.live")

MARKER_FIELDS = (
    "phase_id", "layer_id", "orbat_node_id", "orbat_strength", "sidc", "world_x", "world_y",
    "rotation_degrees", "icon_rotation", "scale",
    "unit_text", "ai_text", "channel", "timestamp_visible",
    "linked_group_id", "point_index", "line_color", "line_width",
)


def _auth(cookies: dict[str, str], plan_id: str) -> tuple[User, Plan, str, dict, bool] | None:
    token = cookies.get(SESSION_COOKIE)
    sess = read_session(token) if token else None
    if not sess:
        return None
    uid, epoch = sess
    with SessionLocal() as db:
        user = db.get(User, uid)
        plan = db.get(Plan, plan_id)
        if user is None or not user.is_active or epoch != (user.session_epoch or 0):
            return None
        if plan is None or plan.deleted_at is not None:
            return None
        level = effective_level(db, user, plan)
        if level is None:
            return None
        return user, plan, level, effective_caps(db, user, plan), effective_mission_builder(db, user)


_BUILDER_PHASES: dict[str, set[str]] = {}


def _refresh_builder_phases(plan_id: str) -> set[str]:
    with SessionLocal() as db:
        ids = set(
            db.scalars(select(Phase.id).where(Phase.plan_id == plan_id, Phase.plane == "builder"))
        )
    _BUILDER_PHASES[plan_id] = ids
    return ids


def _phase_is_builder(plan_id: str, phase_id: str | None) -> bool:
    if not phase_id:
        return False
    ids = _BUILDER_PHASES.get(plan_id)
    if ids is None or phase_id not in ids:
        ids = _refresh_builder_phases(plan_id)
    return phase_id in ids


def _marker_out(m: Marker, author: str | None = None) -> dict:
    return {
        "id": m.id, "phase_id": m.phase_id, "layer_id": m.layer_id,
        "orbat_node_id": m.orbat_node_id, "orbat_strength": m.orbat_strength, "sidc": m.sidc,
        "world_x": m.world_x, "world_y": m.world_y,
        "rotation_degrees": m.rotation_degrees, "icon_rotation": m.icon_rotation, "scale": m.scale,
        "unit_text": m.unit_text, "ai_text": m.ai_text, "channel": m.channel,
        "author": author,
        "locked": m.locked, "timestamp_visible": m.timestamp_visible,
        "linked_group_id": m.linked_group_id, "point_index": m.point_index,
        "line_color": m.line_color, "line_width": m.line_width,
    }


def _author_of(db, obj: Marker | PlanImage) -> str | None:
    if not obj.created_by:
        return None
    u = db.get(User, obj.created_by)
    return u.label if u else None


async def live_ws(websocket: WebSocket) -> None:
    plan_id = websocket.path_params["plan_id"]
    if not origin_allowed(websocket.headers.get("origin"), websocket.headers.get("host")):
        await websocket.close(code=4403)
        return
    auth = await run_in_threadpool(_auth, websocket.cookies, plan_id)
    if auth is None:
        await websocket.close(code=4403)
        return
    user, _plan, level, caps, is_builder = auth
    is_owner = rank(level) >= rank("owner")

    await websocket.accept()
    await hub.join(plan_id, websocket, is_builder=is_builder)
    await websocket.send_json(
        {"type": "hello", "level": level, "caps": caps, "mission_builder": is_builder}
    )
    await hub.broadcast(plan_id, {"type": "presence.join", "user": user.label, "uid": user.id})

    try:
        while True:
            msg = await websocket.receive_json()
            await _handle(websocket, plan_id, user, caps, is_owner, is_builder, msg)
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        log.exception("live_ws Fehler (plan=%s)", plan_id)
    finally:
        hub.leave(plan_id, websocket)
        await hub.broadcast(plan_id, {"type": "presence.leave", "uid": user.id})


async def _reject(ws: WebSocket, cid: str | None, reason: str) -> None:
    await ws.send_json({"type": "reject", "cid": cid, "reason": reason})


async def _handle(
    ws: WebSocket, plan_id: str, user: User, caps: dict, is_owner: bool,
    is_builder: bool, msg: dict,
) -> None:
    t = msg.get("type")

    def bo(phase_id: str | None) -> bool:
        """builder_only: Op betrifft eine Builder-Phase → nur an Missionsbau-Sockets."""
        return _phase_is_builder(plan_id, phase_id)

    # presence.cursor immer erlaubt (auch für Nur-Leser sinnvoll: "Zeigen")
    if t == "presence.cursor":
        await hub.broadcast(plan_id, {**msg, "uid": user.id, "user": user.label})
        return

    need = {
        "marker.create": "place",
        "marker.move": "move",
        "marker.modify": "move",
        "marker.lock": "move",
        "marker.delete": "delete",
        "stroke.commit": "draw",
        "stroke.begin": "draw",
        "stroke.append": "draw",
        "stroke.modify": "draw",
        "stroke.delete": "draw",
        "annotation.create": "place",
        "annotation.move": "move",
        "annotation.modify": "move",
        "annotation.delete": "delete",
        "image.modify": "move",
        "image.delete": "delete",
        "placement.create": "place",
        "placement.move": "move",
        "placement.modify": "move",
        "placement.delete": "delete",
    }.get(t or "")
    if need is None:
        await _reject(ws, msg.get("cid"), f"Unbekannter Typ: {t}")
        return
    if not caps.get(need):
        await _reject(ws, msg.get("cid"), f"Keine Berechtigung: {need}")
        return

    # Nicht-Missionsbauer dürfen keine Objekte auf Builder-Phasen anlegen/ändern.
    if not is_builder and t in (
        "marker.create", "marker.modify", "stroke.commit", "stroke.modify",
        "annotation.create", "annotation.move", "annotation.modify",
        "image.modify", "placement.create", "placement.move", "placement.modify",
    ):
        pid = (msg.get("data") or {}).get("phase_id")
        if t == "stroke.modify":
            if bo(_stroke_phase(plan_id, msg.get("id"))):
                await _reject(ws, msg.get("cid"), "Keine Berechtigung: Missionsbau-Ebene")
                return
        if bo(pid):
            await _reject(ws, msg.get("cid"), "Keine Berechtigung: Missionsbau-Ebene")
            return

    if t in ("stroke.begin", "stroke.append"):
        # Freihand-Zwischenschritte: an alle (die endgültige stroke.commit filtert)
        await hub.broadcast(plan_id, {**msg, "uid": user.id})
        return

    if t == "marker.create":
        data = {k: msg["data"].get(k) for k in MARKER_FIELDS if k in msg.get("data", {})}
        m = await run_in_threadpool(_create_marker, plan_id, user.id, data)
        await hub.broadcast(
            plan_id, {"type": "marker.upsert", "cid": msg.get("cid"), "marker": m},
            builder_only=bo(m.get("phase_id")),
        )

    elif t == "marker.move":
        res = await run_in_threadpool(
            _update_marker, plan_id, msg["id"], user.id, is_owner,
            {"world_x": msg["world_x"], "world_y": msg["world_y"]},
        )
        await _emit_update(ws, plan_id, msg, res)

    elif t == "marker.modify":
        fields = {k: v for k, v in msg.get("data", {}).items() if k in MARKER_FIELDS}
        res = await run_in_threadpool(_update_marker, plan_id, msg["id"], user.id, is_owner, fields)
        await _emit_update(ws, plan_id, msg, res)

    elif t == "marker.lock":
        res = await run_in_threadpool(
            _update_marker, plan_id, msg["id"], user.id, is_owner, {"locked": bool(msg.get("locked"))}
        )
        await _emit_update(ws, plan_id, msg, res)

    elif t == "marker.delete":
        pid = await run_in_threadpool(_delete_marker, plan_id, msg["id"], is_owner)
        if pid is not False:
            await hub.broadcast(
                plan_id, {"type": "marker.delete", "id": msg["id"]}, builder_only=bo(pid)
            )
        else:
            await _reject(ws, msg.get("cid"), "Marker gesperrt oder nicht vorhanden")

    elif t == "stroke.commit":
        s = await run_in_threadpool(_create_stroke, plan_id, user.id, msg.get("data", {}))
        await hub.broadcast(
            plan_id, {"type": "stroke.upsert", "cid": msg.get("cid"), "stroke": s},
            builder_only=bo(s.get("phase_id")),
        )

    elif t == "stroke.modify":
        s = await run_in_threadpool(_update_stroke, plan_id, msg["id"], msg.get("data", {}))
        if s is not None:
            await hub.broadcast(
                plan_id, {"type": "stroke.upsert", "stroke": s},
                builder_only=bo(s.get("phase_id")),
            )

    elif t == "stroke.delete":
        pid = await run_in_threadpool(_delete_stroke, plan_id, msg["id"])
        await hub.broadcast(
            plan_id, {"type": "stroke.delete", "id": msg["id"]}, builder_only=bo(pid)
        )

    elif t == "annotation.create":
        a = await run_in_threadpool(_create_annotation, plan_id, user.id, msg.get("data", {}))
        await hub.broadcast(
            plan_id, {"type": "annotation.upsert", "cid": msg.get("cid"), "annotation": a},
            builder_only=bo(a.get("phase_id")),
        )

    elif t in ("annotation.move", "annotation.modify"):
        fields = {
            k: v for k, v in msg.get("data", {}).items()
            if k in ("world_x", "world_y", "text", "width", "height", "phase_id", "scale_fixed", "ref_zoom")
        }
        res = await run_in_threadpool(_update_annotation, plan_id, msg["id"], user.id, fields)
        if res is not None:
            await hub.broadcast(
                plan_id, {"type": "annotation.upsert", "annotation": res},
                builder_only=bo(res.get("phase_id")),
            )

    elif t == "annotation.delete":
        pid = await run_in_threadpool(_delete_annotation, plan_id, msg["id"])
        await hub.broadcast(
            plan_id, {"type": "annotation.delete", "id": msg["id"]}, builder_only=bo(pid)
        )

    elif t == "image.modify":
        fields = {k: v for k, v in msg.get("data", {}).items() if k in IMAGE_UPDATE_FIELDS}
        res = await run_in_threadpool(_update_image, plan_id, msg["id"], user.id, fields)
        if res is not None:
            await hub.broadcast(
                plan_id, {"type": "image.upsert", "image": res},
                builder_only=bo(res.get("phase_id")),
            )

    elif t == "image.delete":
        pid = await run_in_threadpool(_delete_image, plan_id, msg["id"])
        await hub.broadcast(
            plan_id, {"type": "image.delete", "id": msg["id"]}, builder_only=bo(pid)
        )

    elif t == "placement.create":
        data = {k: msg["data"].get(k) for k in (*PLACEMENT_UPDATE_FIELDS, "image_id") if k in msg.get("data", {})}
        p = await run_in_threadpool(_create_placement, plan_id, user.id, data)
        if p is not None:
            await hub.broadcast(
                plan_id, {"type": "placement.upsert", "cid": msg.get("cid"), "placement": p},
                builder_only=bo(p.get("phase_id")),
            )
        else:
            await _reject(ws, msg.get("cid"), "Bild nicht gefunden")

    elif t in ("placement.move", "placement.modify"):
        fields = {k: v for k, v in msg.get("data", {}).items() if k in PLACEMENT_UPDATE_FIELDS}
        res = await run_in_threadpool(_update_placement, plan_id, msg["id"], user.id, fields)
        if res is not None:
            await hub.broadcast(
                plan_id, {"type": "placement.upsert", "placement": res},
                builder_only=bo(res.get("phase_id")),
            )

    elif t == "placement.delete":
        pid = await run_in_threadpool(_delete_placement, plan_id, msg["id"])
        await hub.broadcast(
            plan_id, {"type": "placement.delete", "id": msg["id"]}, builder_only=bo(pid)
        )


async def _emit_update(ws: WebSocket, plan_id: str, msg: dict, res: dict | None) -> None:
    if res is None:
        await _reject(ws, msg.get("cid"), "Marker gesperrt oder nicht vorhanden")
    else:
        await hub.broadcast(
            plan_id, {"type": "marker.upsert", "marker": res},
            builder_only=_phase_is_builder(plan_id, res.get("phase_id")),
        )


# ─── DB-Operationen (im Threadpool) ────────────────────────────────────────

def _losses(status: str, strength: int) -> int:
    return int(strength or 0) if status == "destroyed" else 0


def _sync_node(db, node_id: str | None, *, delta: int = 0) -> None:
    """ORBAT-Knoten pflegen: ``qty_current`` um ``delta`` verschieben (Verluste
    durch zerstörte Marker; manuelle Korrektur bleibt erhalten), Status = schlimmster
    Status der verknüpften Marker."""
    if not node_id:
        return
    n = db.get(OrbatNode, node_id)
    if n is None:
        return
    if delta:
        n.qty_current = max(0, (n.qty_current or 0) + delta)
    states = [
        status_from_sidc(m.sidc)
        for m in db.scalars(select(Marker).where(Marker.orbat_node_id == node_id))
    ]
    if states:
        n.status = (
            "destroyed" if "destroyed" in states
            else "damaged" if "damaged" in states
            else "active"
        )
    db.commit()


def _create_marker(plan_id: str, uid: str, data: dict) -> dict:
    with SessionLocal() as db:
        m = Marker(plan_id=plan_id, created_by=uid, updated_by=uid, **data)
        db.add(m)
        db.commit()
        _sync_node(db, m.orbat_node_id,
                   delta=-_losses(status_from_sidc(m.sidc), m.orbat_strength))
        return _marker_out(m, _author_of(db, m))


def _update_marker(plan_id: str, marker_id: str, uid: str, is_owner: bool, fields: dict) -> dict | None:
    with SessionLocal() as db:
        m = db.get(Marker, marker_id)
        if m is None or m.plan_id != plan_id:
            return None
        if m.locked and not is_owner and "locked" not in fields:
            return None
        old_node = m.orbat_node_id
        old_loss = _losses(status_from_sidc(m.sidc), m.orbat_strength)
        for k, v in fields.items():
            setattr(m, k, v)
        m.updated_by = uid
        m.updated_at = now()
        db.commit()
        new_loss = _losses(status_from_sidc(m.sidc), m.orbat_strength)
        if old_node and old_node != m.orbat_node_id:
            _sync_node(db, old_node, delta=old_loss)          # Verlust zieht mit dem Marker weg
            _sync_node(db, m.orbat_node_id, delta=-new_loss)  # am neuen Knoten neu ansetzen
        else:
            _sync_node(db, m.orbat_node_id, delta=old_loss - new_loss)
        return _marker_out(m, _author_of(db, m))


def _delete_marker(plan_id: str, marker_id: str, is_owner: bool):
    """Gibt die phase_id des gelöschten Markers zurück (kann None sein), oder
    ``False`` wenn nicht gelöscht (gesperrt / nicht vorhanden)."""
    with SessionLocal() as db:
        m = db.get(Marker, marker_id)
        if m is None or m.plan_id != plan_id or (m.locked and not is_owner):
            return False
        pid = m.phase_id
        node_id = m.orbat_node_id
        loss = _losses(status_from_sidc(m.sidc), m.orbat_strength)
        db.delete(m)
        db.commit()
        _sync_node(db, node_id, delta=loss)  # Verlust dieses Markers entfällt
        return pid


def _create_stroke(plan_id: str, uid: str, data: dict) -> dict:
    with SessionLocal() as db:
        s = Stroke(
            plan_id=plan_id, created_by=uid,
            phase_id=data.get("phase_id"), layer_id=data.get("layer_id"),
            kind=data.get("kind", "freehand"), points=data.get("points", []),
            channel=str(data.get("channel") or ""),
            color=data.get("color", -1), width=data.get("width", -1),
        )
        db.add(s)
        db.commit()
        return _stroke_out(s)


def _stroke_out(s: Stroke) -> dict:
    return {
        "id": s.id, "phase_id": s.phase_id, "layer_id": s.layer_id, "kind": s.kind,
        "channel": s.channel, "points": s.points, "color": s.color, "width": s.width,
    }


def _stroke_phase(plan_id: str, stroke_id: str | None) -> str | None:
    if not stroke_id:
        return None
    with SessionLocal() as db:
        s = db.get(Stroke, stroke_id)
        return s.phase_id if s and s.plan_id == plan_id else None


def _update_stroke(plan_id: str, stroke_id: str, data: dict) -> dict | None:
    with SessionLocal() as db:
        s = db.get(Stroke, stroke_id)
        if s is None or s.plan_id != plan_id:
            return None
        pts = data.get("points")
        if isinstance(pts, list) and len(pts) >= 2:
            s.points = [[float(p[0]), float(p[1])] for p in pts]
        if data.get("color") is not None:
            s.color = int(data["color"])
        if data.get("width") is not None:
            s.width = float(data["width"])
        if "phase_id" in data:
            s.phase_id = data["phase_id"] or None
        if "channel" in data:
            s.channel = str(data["channel"] or "")
        db.commit()
        return _stroke_out(s)


def _delete_stroke(plan_id: str, stroke_id: str) -> str | None:
    with SessionLocal() as db:
        s = db.get(Stroke, stroke_id)
        if s is None or s.plan_id != plan_id:
            return None
        pid = s.phase_id
        db.delete(s)
        db.commit()
        return pid


def _annotation_out(a: Annotation) -> dict:
    return {
        "id": a.id, "plan_id": a.plan_id, "phase_id": a.phase_id,
        "world_x": a.world_x, "world_y": a.world_y, "text": a.text,
        "width": a.width, "height": a.height,
        "scale_fixed": a.scale_fixed, "ref_zoom": a.ref_zoom,
    }


def _create_annotation(plan_id: str, uid: str, data: dict) -> dict:
    with SessionLocal() as db:
        a = Annotation(
            plan_id=plan_id, created_by=uid, updated_by=uid,
            phase_id=data.get("phase_id"),
            world_x=float(data.get("world_x", 0)), world_y=float(data.get("world_y", 0)),
            text=str(data.get("text", ""))[:8000], width=float(data.get("width", 220)),
            height=float(data.get("height", 0)),
            scale_fixed=bool(data.get("scale_fixed", False)),
            ref_zoom=float(data.get("ref_zoom", 0)),
        )
        db.add(a)
        db.commit()
        return _annotation_out(a)


def _update_annotation(plan_id: str, ann_id: str, uid: str, fields: dict) -> dict | None:
    with SessionLocal() as db:
        a = db.get(Annotation, ann_id)
        if a is None or a.plan_id != plan_id:
            return None
        if "text" in fields:
            fields["text"] = str(fields["text"])[:8000]
        for k, v in fields.items():
            setattr(a, k, v)
        a.updated_by = uid
        a.updated_at = now()
        db.commit()
        return _annotation_out(a)


def _delete_annotation(plan_id: str, ann_id: str) -> str | None:
    with SessionLocal() as db:
        a = db.get(Annotation, ann_id)
        if a is None or a.plan_id != plan_id:
            return None
        pid = a.phase_id
        db.delete(a)
        db.commit()
        return pid


# ── Plan-Bilder ────────────────────────────────────────────────────────────

# Nur noch Metadaten - Karten-Platzierung läuft über ImagePlacement/image_placements.
IMAGE_UPDATE_FIELDS = ("caption", "note", "phase_id")


def _image_out(i: PlanImage, author: str | None = None) -> dict:
    return {
        "id": i.id, "plan_id": i.plan_id, "phase_id": i.phase_id,
        "filename": i.filename, "content_type": i.content_type, "byte_size": i.byte_size,
        "natural_w": i.natural_w, "natural_h": i.natural_h, "caption": i.caption, "note": i.note,
        "author": author,
    }


def _create_image(plan_id: str, uid: str | None, meta: dict, raw: bytes, sniff: tuple[str, int, int]) -> dict:
    ct, w, h = sniff
    with SessionLocal() as db:
        i = PlanImage(
            plan_id=plan_id, created_by=uid, updated_by=uid,
            phase_id=meta.get("phase_id") or None,
            filename=str(meta.get("filename", ""))[:255],
            caption=str(meta.get("caption", ""))[:2000],
            content_type=ct, byte_size=len(raw), natural_w=w, natural_h=h,
            data=raw,
        )
        db.add(i)
        db.commit()
        return _image_out(i, _author_of(db, i))


def _update_image(plan_id: str, image_id: str, uid: str | None, fields: dict) -> dict | None:
    with SessionLocal() as db:
        i = db.get(PlanImage, image_id)
        if i is None or i.plan_id != plan_id:
            return None
        if "caption" in fields:
            fields["caption"] = str(fields["caption"])[:2000]
        if "note" in fields:
            fields["note"] = str(fields["note"])[:20000]
        for k, v in fields.items():
            setattr(i, k, v)
        i.updated_by = uid
        i.updated_at = now()
        db.commit()
        return _image_out(i, _author_of(db, i))


def _delete_image(plan_id: str, image_id: str) -> str | None:
    with SessionLocal() as db:
        i = db.get(PlanImage, image_id)
        if i is None or i.plan_id != plan_id:
            return None
        pid = i.phase_id
        # Explizit statt nur per DB-CASCADE: SQLite (Tests) erzwingt Fremdschlüssel
        # ohne "PRAGMA foreign_keys=ON" standardmäßig nicht.
        for p in db.scalars(select(ImagePlacement).where(ImagePlacement.image_id == image_id)):
            db.delete(p)
        db.delete(i)
        db.commit()
        return pid


# ── Bild-Platzierungen (ein Bild kann mehrfach/in mehreren Phasen liegen) ──

PLACEMENT_UPDATE_FIELDS = ("world_x", "world_y", "map_width", "scale_fixed", "ref_zoom", "phase_id")


def _image_owner_phase(plan_id: str, image_id: str) -> tuple[bool, str | None]:
    """(gefunden?, phase_id des Bilds) — für die Sichtbarkeitsprüfung vor
    ``placement.create`` im öffentlichen Link."""
    with SessionLocal() as db:
        i = db.get(PlanImage, image_id)
        if i is None or i.plan_id != plan_id:
            return False, None
        return True, i.phase_id


def _placement_out(p: ImagePlacement) -> dict:
    return {
        "id": p.id, "image_id": p.image_id, "plan_id": p.plan_id, "phase_id": p.phase_id,
        "world_x": p.world_x, "world_y": p.world_y, "map_width": p.map_width,
        "scale_fixed": p.scale_fixed, "ref_zoom": p.ref_zoom,
    }


def _create_placement(plan_id: str, uid: str | None, data: dict) -> dict | None:
    with SessionLocal() as db:
        img = db.get(PlanImage, data.get("image_id"))
        if img is None or img.plan_id != plan_id:
            return None
        p = ImagePlacement(
            plan_id=plan_id, image_id=img.id, created_by=uid, updated_by=uid,
            phase_id=data.get("phase_id"),
            world_x=float(data.get("world_x", 0)), world_y=float(data.get("world_y", 0)),
            map_width=float(data.get("map_width", 240)),
            scale_fixed=bool(data.get("scale_fixed", False)),
            ref_zoom=float(data.get("ref_zoom", 0)),
        )
        db.add(p)
        db.commit()
        return _placement_out(p)


def _update_placement(plan_id: str, placement_id: str, uid: str | None, fields: dict) -> dict | None:
    with SessionLocal() as db:
        p = db.get(ImagePlacement, placement_id)
        if p is None or p.plan_id != plan_id:
            return None
        for k, v in fields.items():
            setattr(p, k, v)
        p.updated_by = uid
        p.updated_at = now()
        db.commit()
        return _placement_out(p)


def _delete_placement(plan_id: str, placement_id: str) -> str | None:
    with SessionLocal() as db:
        p = db.get(ImagePlacement, placement_id)
        if p is None or p.plan_id != plan_id:
            return None
        pid = p.phase_id
        db.delete(p)
        db.commit()
        return pid
