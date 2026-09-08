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


def _resolve(token: str, db) -> Plan:
    sh = db.get(PublicShare, token)
    if sh is None or sh.revoked:
        raise HTTPException(404, "Freigabe nicht gefunden")
    if sh.expires_at and sh.expires_at < datetime.now(timezone.utc):
        raise HTTPException(410, "Freigabe abgelaufen")
    plan = db.get(Plan, sh.plan_id)
    if plan is None or plan.deleted_at is not None:
        raise HTTPException(404, "Plan nicht gefunden")
    return plan


@router.get("/{token}")
def public_snapshot(token: str, db: DbDep) -> dict:
    plan = _resolve(token, db)
    mp = db.get(Map, plan.map_id)
    hide = _builder_phase_ids(db, plan.id)  # Missionsbau-Ebene nie öffentlich
    markers = [
        _marker_out(m)
        for m in db.scalars(select(Marker).where(Marker.plan_id == plan.id))
        if m.phase_id not in hide
    ] + released_markers(db, plan.id)
    return {
        "plan": {"id": plan.id, "name": plan.name, "map_id": plan.map_id},
        "map_meta": (mp.meta if mp else {}),
        "readonly": True,
        "phases": [
            {"id": p.id, "name": p.name, "ordering": p.ordering,
             "start_at": p.start_at.isoformat() if p.start_at else None}
            for p in db.scalars(
                select(Phase)
                .where(Phase.plan_id == plan.id, Phase.plane.is_distinct_from("builder"))
                .order_by(Phase.ordering)
            )
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
            if s.phase_id not in hide
        ],
        "annotations": [
            {"id": a.id, "phase_id": a.phase_id, "world_x": a.world_x, "world_y": a.world_y,
             "text": a.text, "width": a.width,
             "scale_fixed": a.scale_fixed, "ref_zoom": a.ref_zoom}
            for a in db.scalars(select(Annotation).where(Annotation.plan_id == plan.id))
            if a.phase_id not in hide
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
    with SessionLocal() as db:
        try:
            plan = _resolve(token, db)
        except HTTPException:
            await websocket.close(code=4404)
            return
        plan_id = plan.id
    await websocket.accept()
    await hub.join(plan_id, websocket)
    try:
        while True:
            await websocket.receive_text()  # Empfänger ignoriert alles
    except WebSocketDisconnect:
        pass
    finally:
        hub.leave(plan_id, websocket)
