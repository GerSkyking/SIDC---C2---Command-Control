"""WebSocket-Endpoint pro Plan — autoritativer Server.

Client rendert Anlegen/Freihand optimistisch und schickt eine temporäre `cid`;
der Server bestätigt mit der echten ID (`marker.upsert` inkl. `cid`) oder lehnt
mit `reject` ab. Verschieben/Ändern/Löschen/Sperren laufen ausschließlich über den
Server und werden gegen Rechte + Marker-Lock geprüft.
"""
from __future__ import annotations

import logging

from starlette.concurrency import run_in_threadpool
from starlette.websockets import WebSocket, WebSocketDisconnect

from ..db import SessionLocal
from ..models import Marker, Plan, Stroke, User, now
from ..permissions import effective_caps, effective_level, rank
from ..security import SESSION_COOKIE, read_session
from ..services.realtime import hub

log = logging.getLogger("sidc.live")

MARKER_FIELDS = (
    "phase_id", "layer_id", "sidc", "world_x", "world_y", "rotation_degrees", "icon_rotation",
    "unit_text", "ai_text", "channel", "timestamp_visible",
    "linked_group_id", "point_index", "line_color", "line_width",
)


def _auth(cookies: dict[str, str], plan_id: str) -> tuple[User, Plan, str, dict] | None:
    token = cookies.get(SESSION_COOKIE)
    uid = read_session(token) if token else None
    if not uid:
        return None
    with SessionLocal() as db:
        user = db.get(User, uid)
        plan = db.get(Plan, plan_id)
        if user is None or not user.is_active or plan is None or plan.deleted_at is not None:
            return None
        level = effective_level(db, user, plan)
        if level is None:
            return None
        return user, plan, level, effective_caps(db, user, plan)


def _marker_out(m: Marker) -> dict:
    return {
        "id": m.id, "phase_id": m.phase_id, "layer_id": m.layer_id, "sidc": m.sidc,
        "world_x": m.world_x, "world_y": m.world_y,
        "rotation_degrees": m.rotation_degrees, "icon_rotation": m.icon_rotation,
        "unit_text": m.unit_text, "ai_text": m.ai_text, "channel": m.channel,
        "locked": m.locked, "timestamp_visible": m.timestamp_visible,
        "linked_group_id": m.linked_group_id, "point_index": m.point_index,
        "line_color": m.line_color, "line_width": m.line_width,
    }


async def live_ws(websocket: WebSocket) -> None:
    plan_id = websocket.path_params["plan_id"]
    auth = await run_in_threadpool(_auth, websocket.cookies, plan_id)
    if auth is None:
        await websocket.close(code=4403)
        return
    user, _plan, level, caps = auth
    is_owner = rank(level) >= rank("owner")

    await websocket.accept()
    await hub.join(plan_id, websocket)
    await websocket.send_json({"type": "hello", "level": level, "caps": caps})
    await hub.broadcast(plan_id, {"type": "presence.join", "user": user.username, "uid": user.id})

    try:
        while True:
            msg = await websocket.receive_json()
            await _handle(websocket, plan_id, user, caps, is_owner, msg)
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
    ws: WebSocket, plan_id: str, user: User, caps: dict, is_owner: bool, msg: dict
) -> None:
    t = msg.get("type")

    # presence.cursor immer erlaubt (auch für Nur-Leser sinnvoll: "Zeigen")
    if t == "presence.cursor":
        await hub.broadcast(plan_id, {**msg, "uid": user.id})
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
        "stroke.delete": "draw",
    }.get(t or "")
    if need is None:
        await _reject(ws, msg.get("cid"), f"Unbekannter Typ: {t}")
        return
    if not caps.get(need):
        await _reject(ws, msg.get("cid"), f"Keine Berechtigung: {need}")
        return

    if t in ("stroke.begin", "stroke.append"):
        await hub.broadcast(plan_id, {**msg, "uid": user.id})
        return

    if t == "marker.create":
        data = {k: msg["data"].get(k) for k in MARKER_FIELDS if k in msg.get("data", {})}
        m = await run_in_threadpool(_create_marker, plan_id, user.id, data)
        await hub.broadcast(plan_id, {"type": "marker.upsert", "cid": msg.get("cid"), "marker": m})

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
        ok = await run_in_threadpool(_delete_marker, plan_id, msg["id"], is_owner)
        if ok:
            await hub.broadcast(plan_id, {"type": "marker.delete", "id": msg["id"]})
        else:
            await _reject(ws, msg.get("cid"), "Marker gesperrt oder nicht vorhanden")

    elif t == "stroke.commit":
        s = await run_in_threadpool(_create_stroke, plan_id, user.id, msg.get("data", {}))
        await hub.broadcast(plan_id, {"type": "stroke.upsert", "cid": msg.get("cid"), "stroke": s})

    elif t == "stroke.delete":
        await run_in_threadpool(_delete_stroke, plan_id, msg["id"])
        await hub.broadcast(plan_id, {"type": "stroke.delete", "id": msg["id"]})


async def _emit_update(ws: WebSocket, plan_id: str, msg: dict, res: dict | None) -> None:
    if res is None:
        await _reject(ws, msg.get("cid"), "Marker gesperrt oder nicht vorhanden")
    else:
        await hub.broadcast(plan_id, {"type": "marker.upsert", "marker": res})


# ─── DB-Operationen (im Threadpool) ────────────────────────────────────────

def _create_marker(plan_id: str, uid: str, data: dict) -> dict:
    with SessionLocal() as db:
        m = Marker(plan_id=plan_id, created_by=uid, updated_by=uid, **data)
        db.add(m)
        db.commit()
        return _marker_out(m)


def _update_marker(plan_id: str, marker_id: str, uid: str, is_owner: bool, fields: dict) -> dict | None:
    with SessionLocal() as db:
        m = db.get(Marker, marker_id)
        if m is None or m.plan_id != plan_id:
            return None
        if m.locked and not is_owner and "locked" not in fields:
            return None
        for k, v in fields.items():
            setattr(m, k, v)
        m.updated_by = uid
        m.updated_at = now()
        db.commit()
        return _marker_out(m)


def _delete_marker(plan_id: str, marker_id: str, is_owner: bool) -> bool:
    with SessionLocal() as db:
        m = db.get(Marker, marker_id)
        if m is None or m.plan_id != plan_id or (m.locked and not is_owner):
            return False
        db.delete(m)
        db.commit()
        return True


def _create_stroke(plan_id: str, uid: str, data: dict) -> dict:
    with SessionLocal() as db:
        s = Stroke(
            plan_id=plan_id, created_by=uid,
            phase_id=data.get("phase_id"), layer_id=data.get("layer_id"),
            kind=data.get("kind", "freehand"), points=data.get("points", []),
            color=data.get("color", -1), width=data.get("width", -1),
        )
        db.add(s)
        db.commit()
        return {
            "id": s.id, "phase_id": s.phase_id, "layer_id": s.layer_id, "kind": s.kind,
            "points": s.points, "color": s.color, "width": s.width,
        }


def _delete_stroke(plan_id: str, stroke_id: str) -> None:
    with SessionLocal() as db:
        s = db.get(Stroke, stroke_id)
        if s is not None and s.plan_id == plan_id:
            db.delete(s)
            db.commit()
