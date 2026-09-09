"""Öffentliche Nur-Lese-Ansicht eines Plans über einen Freigabe-Token (ohne Login)."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import JSONResponse
from sqlalchemy import select
from starlette.websockets import WebSocket, WebSocketDisconnect

from ..db import SessionLocal
from ..deps import DbDep
from ..models import Annotation, Layer, Map, Marker, Phase, Plan, PublicShare, Stroke
from ..services.maps_import import map_dir
from ..services.realtime import hub
from .live import _marker_out
from .plans import _builder_phase_ids, _stroke_dict, released_markers
from .tiles import build_style, read_tile

router = APIRouter(prefix="/public/plans", tags=["public"])


def _resolve_share(token: str, db) -> tuple[Plan, PublicShare]:
    sh = db.get(PublicShare, token)
    if sh is None or sh.revoked:
        raise HTTPException(404, "Freigabe nicht gefunden")
    if sh.expires_at and sh.expires_at < datetime.now(timezone.utc):
        raise HTTPException(410, "Freigabe abgelaufen")
    plan = db.get(Plan, sh.plan_id)
    if plan is None or plan.deleted_at is not None:
        raise HTTPException(404, "Plan nicht gefunden")
    return plan, sh


def _resolve(token: str, db) -> Plan:
    return _resolve_share(token, db)[0]


def _phase_spans(db, plan_id: str, h_hour) -> dict[str, tuple]:
    """Effektives [Start, Ende] je Phase — Spieler-Phasen ketten sich 1h ab der
    H-Stunde, wenn keine eigene Zeit gesetzt ist (wie im Frontend-Zeitstrahl)."""
    from datetime import timedelta

    base = h_hour or datetime.now(timezone.utc).replace(hour=8, minute=0, second=0, microsecond=0)
    rows = list(db.scalars(
        select(Phase).where(Phase.plan_id == plan_id).order_by(Phase.ordering, Phase.sub_ordering)
    ))
    out: dict[str, tuple] = {}
    cursor = base
    for p in sorted([r for r in rows if (r.plane or "player") != "builder"], key=lambda x: x.ordering):
        s = p.start_at or cursor
        e = p.end_at or (s + timedelta(hours=1))
        out[p.id] = (s, e)
        cursor = e
    for p in [r for r in rows if r.plane == "builder"]:
        par = out.get(p.parent_id or "")
        s = p.start_at or (par[0] if par else base)
        e = p.end_at or (par[1] if par else s + timedelta(hours=1))
        out[p.id] = (s, e)
    return out


def _allowed_phases(db, plan, sh) -> set[str] | None:
    """None = alle Phasen erlaubt; sonst die erlaubte Menge an Phasen-IDs."""
    if sh.phase_ids:
        return {str(x) for x in sh.phase_ids}
    if sh.date_from or sh.date_to:
        spans = _phase_spans(db, plan.id, plan.h_hour)
        lo = sh.date_from or datetime.min.replace(tzinfo=timezone.utc)
        hi = sh.date_to or datetime.max.replace(tzinfo=timezone.utc)
        return {pid for pid, (s, e) in spans.items() if s <= hi and e >= lo}
    return None


@router.get("/{token}")
def public_snapshot(token: str, db: DbDep) -> dict:
    from .catalog import read_catalog

    plan, sh = _resolve_share(token, db)
    mp = db.get(Map, plan.map_id)
    incl = bool(sh.include_builder)
    hide: set[str] = set() if incl else _builder_phase_ids(db, plan.id)
    allow = _allowed_phases(db, plan, sh)  # None = alle

    def ok(pid) -> bool:
        if pid in hide:
            return False
        if allow is None or pid is None:
            return True
        return pid in allow

    markers = [
        _marker_out(m)
        for m in db.scalars(select(Marker).where(Marker.plan_id == plan.id))
        if ok(m.phase_id)
    ]
    if not incl:
        markers += [rm for rm in released_markers(db, plan.id) if ok(rm.get("phase_id"))]
    phase_q = select(Phase).where(Phase.plan_id == plan.id)
    if not incl:
        phase_q = phase_q.where(Phase.plane.is_distinct_from("builder"))
    return {
        "plan": {
            "id": plan.id, "name": plan.name, "map_id": plan.map_id,
            "h_hour": plan.h_hour.isoformat() if plan.h_hour else None,
        },
        "map_meta": (mp.meta if mp else {}),
        "readonly": not (sh.can_edit or sh.can_move),
        "rights": {"point": sh.can_point, "edit": sh.can_edit, "move": sh.can_move},
        "include_builder": incl,
        "channels": read_catalog("channels"),
        "phases": [
            {"id": p.id, "name": p.name, "ordering": p.ordering,
             "plane": p.plane or "player", "parent_id": p.parent_id,
             "sub_ordering": p.sub_ordering or 0,
             "start_at": p.start_at.isoformat() if p.start_at else None,
             "end_at": p.end_at.isoformat() if p.end_at else None}
            for p in db.scalars(phase_q.order_by(Phase.ordering, Phase.sub_ordering))
            if allow is None or p.id in allow
        ],
        "layers": [
            {"id": ly.id, "name": ly.name, "color": ly.color, "ordering": ly.ordering,
             "group_id": ly.group_id, "is_default": ly.is_default}
            for ly in db.scalars(select(Layer).where(Layer.plan_id == plan.id).order_by(Layer.ordering))
        ],
        "markers": markers,
        "strokes": [
            _stroke_dict(s)
            for s in db.scalars(select(Stroke).where(Stroke.plan_id == plan.id))
            if ok(s.phase_id)
        ],
        "annotations": [
            {"id": a.id, "phase_id": a.phase_id, "world_x": a.world_x, "world_y": a.world_y,
             "text": a.text, "width": a.width, "height": a.height,
             "scale_fixed": a.scale_fixed, "ref_zoom": a.ref_zoom}
            for a in db.scalars(select(Annotation).where(Annotation.plan_id == plan.id))
            if ok(a.phase_id)
        ],
    }


@router.get("/{token}/style.json")
def public_style(token: str, db: DbDep) -> JSONResponse:
    plan = _resolve(token, db)
    return JSONResponse(
        build_style(plan.map_id, f"/public/plans/{token}/tiles"),
        headers={"Cache-Control": "no-cache"},
    )


@router.get("/{token}/tiles/{layer}/{z}/{x}/{y}.png")
def public_tile(token: str, layer: str, z: int, x: int, y: int, db: DbDep) -> Response:
    plan = _resolve(token, db)
    data = read_tile(plan.map_id, layer, z, x, y)
    if data is None:
        raise HTTPException(404)
    return Response(data, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


@router.get("/{token}/topo.geojson")
def public_topo(token: str, db: DbDep) -> Response:
    plan = _resolve(token, db)
    p = map_dir(plan.map_id) / "topo.geojson"
    if not p.is_file():
        raise HTTPException(404)
    return Response(p.read_bytes(), media_type="application/geo+json")


@router.get("/{token}/locations.json")
def public_locations(token: str, db: DbDep) -> Response:
    plan = _resolve(token, db)
    p = map_dir(plan.map_id) / "locations.json"
    if not p.is_file():
        raise HTTPException(404)
    return Response(p.read_bytes(), media_type="application/json")


@router.get("/{token}/contours.geojson")
def public_contours(token: str, db: DbDep) -> Response:
    plan = _resolve(token, db)
    p = map_dir(plan.map_id) / "contours.geojson"
    if not p.is_file():
        raise HTTPException(404)
    return Response(p.read_bytes(), media_type="application/geo+json")


@router.get("/{token}/peaks.geojson")
def public_peaks(token: str, db: DbDep) -> Response:
    plan = _resolve(token, db)
    p = map_dir(plan.map_id) / "peaks.geojson"
    if not p.is_file():
        raise HTTPException(404)
    return Response(p.read_bytes(), media_type="application/geo+json")


@router.websocket("/{token}/live")
async def public_live(websocket: WebSocket, token: str) -> None:
    import secrets

    from starlette.concurrency import run_in_threadpool

    from .live import (
        MARKER_FIELDS, _create_annotation, _create_marker, _create_stroke,
        _delete_annotation, _delete_marker, _delete_stroke, _update_annotation, _update_marker,
    )

    with SessionLocal() as db:
        try:
            plan, sh = _resolve_share(token, db)
        except HTTPException:
            await websocket.close(code=4404)
            return
        plan_id = plan.id
        can_point, can_edit, can_move = sh.can_point, sh.can_edit, sh.can_move
        incl = bool(sh.include_builder)
        hide = set() if incl else _builder_phase_ids(db, plan.id)
        allow = _allowed_phases(db, plan, sh)

    def phase_ok(pid) -> bool:
        if pid in hide:
            return False
        return allow is None or pid is None or pid in allow

    await websocket.accept()
    await hub.join(plan_id, websocket)
    uid = "pub-" + secrets.token_hex(6)
    try:
        while True:
            try:
                msg = await websocket.receive_json()
            except (ValueError, TypeError):
                continue
            if not isinstance(msg, dict):
                continue
            typ = msg.get("type")

            if typ == "presence.cursor" and can_point:
                await hub.broadcast(plan_id, {
                    "type": "presence.cursor", "uid": uid,
                    "user": str(msg.get("user") or "Gast")[:24],
                    "lng": float(msg.get("lng", 0)), "lat": float(msg.get("lat", 0)),
                })
                continue

            data = msg.get("data") or {}
            if typ == "marker.create" and can_edit:
                if not phase_ok(data.get("phase_id")):
                    continue
                d = {k: data.get(k) for k in MARKER_FIELDS if k in data}
                m = await run_in_threadpool(_create_marker, plan_id, None, d)
                await hub.broadcast(plan_id, {"type": "marker.upsert", "cid": msg.get("cid"), "marker": m})
            elif typ == "marker.move" and (can_move or can_edit):
                res = await run_in_threadpool(
                    _update_marker, plan_id, msg["id"], None, False,
                    {"world_x": msg["world_x"], "world_y": msg["world_y"]},
                )
                if res and phase_ok(res.get("phase_id")):
                    await hub.broadcast(plan_id, {"type": "marker.upsert", "marker": res})
            elif typ == "marker.modify" and can_edit:
                fields = {k: v for k, v in data.items() if k in MARKER_FIELDS}
                res = await run_in_threadpool(_update_marker, plan_id, msg["id"], None, False, fields)
                if res and phase_ok(res.get("phase_id")):
                    await hub.broadcast(plan_id, {"type": "marker.upsert", "marker": res})
            elif typ == "marker.delete" and can_edit:
                pid = await run_in_threadpool(_delete_marker, plan_id, msg["id"], False)
                if pid is not False:
                    await hub.broadcast(plan_id, {"type": "marker.delete", "id": msg["id"]})
            elif typ == "stroke.commit" and can_edit:
                if not phase_ok(data.get("phase_id")):
                    continue
                s = await run_in_threadpool(_create_stroke, plan_id, None, data)
                await hub.broadcast(plan_id, {"type": "stroke.upsert", "cid": msg.get("cid"), "stroke": s})
            elif typ == "stroke.delete" and can_edit:
                await run_in_threadpool(_delete_stroke, plan_id, msg["id"])
                await hub.broadcast(plan_id, {"type": "stroke.delete", "id": msg["id"]})
            elif typ == "annotation.create" and can_edit:
                if not phase_ok(data.get("phase_id")):
                    continue
                a = await run_in_threadpool(_create_annotation, plan_id, None, data)
                await hub.broadcast(plan_id, {"type": "annotation.upsert", "cid": msg.get("cid"), "annotation": a})
            elif typ in ("annotation.move", "annotation.modify") and (can_edit or can_move):
                fields = {
                    k: v for k, v in data.items()
                    if k in ("world_x", "world_y", "text", "width", "height", "phase_id", "scale_fixed", "ref_zoom")
                }
                res = await run_in_threadpool(_update_annotation, plan_id, msg["id"], None, fields)
                if res:
                    await hub.broadcast(plan_id, {"type": "annotation.upsert", "annotation": res})
            elif typ == "annotation.delete" and can_edit:
                await run_in_threadpool(_delete_annotation, plan_id, msg["id"])
                await hub.broadcast(plan_id, {"type": "annotation.delete", "id": msg["id"]})
    except WebSocketDisconnect:
        pass
    finally:
        hub.leave(plan_id, websocket)
        await hub.broadcast(plan_id, {"type": "presence.leave", "uid": uid})
