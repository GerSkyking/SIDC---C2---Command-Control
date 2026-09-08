"""Karten: Liste (alle angemeldeten User) + Import/Löschen (Admin).

Import wahlweise per Download-Link ODER Direkt-Upload (gestreamt auf Platte).
"""
from __future__ import annotations

import shutil

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, status
from sqlalchemy import select

from urllib.parse import urlparse

from .. import audit
from ..config import get_settings
from ..deps import AdminUser, CurrentUser, DbDep
from ..models import Map, MapSource, Plan, now
from ..schemas import MapImportFromSourceIn, MapImportIn, MapOut
from .map_sources import _list_files
from ..services.maps_import import map_dir, run_import

router = APIRouter(prefix="/api/maps", tags=["maps"])
_settings = get_settings()
_ID_RE = r"^[a-z0-9][a-z0-9_-]{1,63}$"


@router.get("", response_model=list[MapOut])
def list_maps(user: CurrentUser, db: DbDep) -> list[Map]:
    return list(db.scalars(select(Map).order_by(Map.name)))


@router.post("", response_model=MapOut, status_code=status.HTTP_202_ACCEPTED)
def import_map(
    body: MapImportIn, request: Request, bg: BackgroundTasks, admin: AdminUser, db: DbDep
) -> Map:
    if db.get(Map, body.id) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Karten-ID existiert bereits")
    m = Map(id=body.id, name=body.name, status="importing", source_url=body.url, created_at=now())
    db.add(m)
    db.commit()
    audit.record(db, "map.import", user_id=admin.id, target_type="map", target_id=body.id,
                 request=request, name=body.name, via="url")
    bg.add_task(run_import, body.id, url=body.url)
    return m


@router.post("/{map_id}/upload", response_model=MapOut, status_code=status.HTTP_202_ACCEPTED)
async def upload_map(
    map_id: str, request: Request, bg: BackgroundTasks, admin: AdminUser, db: DbDep, name: str = ""
) -> Map:
    """Rohen ZIP-Body streamen (Direkt-Upload/-Update). `name` als Query-Parameter,
    bei vorhandener Karte optional."""
    import re

    if not re.match(_ID_RE, map_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ungültige Karten-ID")
    existing = db.get(Map, map_id)

    dest = _settings.maps_dir / f".import_{map_id}.zip"
    dest.parent.mkdir(parents=True, exist_ok=True)
    limit = _settings.map_import_max_mb * 1024 * 1024
    written = 0
    try:
        with dest.open("wb") as f:
            async for chunk in request.stream():
                written += len(chunk)
                if written > limit:
                    raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Datei zu groß")
                f.write(chunk)
    except HTTPException:
        dest.unlink(missing_ok=True)
        raise
    if written == 0:
        dest.unlink(missing_ok=True)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Leerer Upload")

    if existing is not None:
        existing.status = "importing"
        existing.error = None
        if name:
            existing.name = name
        m = existing
    else:
        m = Map(id=map_id, name=name or map_id, status="importing", source_url=None, created_at=now())
        db.add(m)
    db.commit()
    audit.record(db, "map.import" if existing is None else "map.update", user_id=admin.id,
                 target_type="map", target_id=map_id, request=request, via="upload", bytes=written)
    bg.add_task(run_import, map_id, zip_path=str(dest))
    return m


@router.post("/import-from-source", response_model=MapOut, status_code=status.HTTP_202_ACCEPTED)
def import_from_source(
    body: MapImportFromSourceIn, request: Request, bg: BackgroundTasks, admin: AdminUser, db: DbDep
) -> Map:
    if db.get(Map, body.id) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Karten-ID existiert bereits")
    src = db.get(MapSource, body.source_id)
    if src is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Quelle unbekannt")

    files = {f.name: f for f in _list_files(src)}
    entry = files.get(body.file)
    if entry is None or not entry.download_url:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Datei nicht in der Quelle")

    # SSRF-Schutz: nur der konfigurierte Host bekommt den Token / wird geladen.
    if urlparse(entry.download_url).netloc != urlparse(src.base_url).netloc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Download-URL außerhalb der Quelle")
    headers = {"Authorization": f"token {src.token}"} if src.token else None

    m = Map(id=body.id, name=body.name, status="importing",
            source_url=entry.download_url, created_at=now())
    db.add(m)
    db.commit()
    audit.record(db, "map.import", user_id=admin.id, target_type="map", target_id=body.id,
                 request=request, name=body.name, via="source", source=src.repo)
    bg.add_task(run_import, body.id, url=entry.download_url, headers=headers)
    return m


@router.post("/{map_id}/reimport", response_model=MapOut, status_code=status.HTTP_202_ACCEPTED)
def reimport_map(map_id: str, bg: BackgroundTasks, admin: AdminUser, db: DbDep) -> Map:
    m = db.get(Map, map_id)
    if m is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    if not m.source_url:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Keine Quell-URL hinterlegt (nur Upload)")
    m.status = "importing"
    db.commit()
    bg.add_task(run_import, map_id, url=m.source_url)
    return m


@router.delete("/{map_id}")
def delete_map(map_id: str, request: Request, admin: AdminUser, db: DbDep) -> None:
    m = db.get(Map, map_id)
    if m is None:
        return
    in_use = db.scalar(select(Plan.id).where(Plan.map_id == map_id, Plan.deleted_at.is_(None)))
    if in_use:
        raise HTTPException(status.HTTP_409_CONFLICT, "Karte wird von Plänen genutzt")
    db.delete(m)
    db.commit()
    audit.record(db, "map.delete", user_id=admin.id, target_type="map", target_id=map_id, request=request)
    d = map_dir(map_id)
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)
