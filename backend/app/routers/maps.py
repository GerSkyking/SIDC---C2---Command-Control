"""Karten: Liste (alle angemeldeten User) + Import/Löschen (Admin).

Tile-/style.json-Routen werden aus ATAKmaps (server/app.py) in einer eigenen Phase
portiert; hier steht zunächst nur die Verwaltung.
"""
from __future__ import annotations

import shutil

from fastapi import APIRouter, BackgroundTasks, HTTPException, status
from sqlalchemy import select

from ..config import get_settings
from ..deps import AdminUser, CurrentUser, DbDep
from ..models import Map, Plan, now
from ..schemas import MapImportIn, MapOut
from ..services.maps_import import map_dir, run_import

router = APIRouter(prefix="/api/maps", tags=["maps"])
_settings = get_settings()


@router.get("", response_model=list[MapOut])
def list_maps(user: CurrentUser, db: DbDep) -> list[Map]:
    return list(db.scalars(select(Map).order_by(Map.name)))


@router.post("", response_model=MapOut, status_code=status.HTTP_202_ACCEPTED)
def import_map(body: MapImportIn, bg: BackgroundTasks, admin: AdminUser, db: DbDep) -> Map:
    if db.get(Map, body.id) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Karten-ID existiert bereits")
    m = Map(id=body.id, name=body.name, status="importing", source_url=body.url, created_at=now())
    db.add(m)
    db.commit()
    bg.add_task(run_import, body.id, body.url)
    return m


@router.post("/{map_id}/reimport", response_model=MapOut, status_code=status.HTTP_202_ACCEPTED)
def reimport_map(map_id: str, bg: BackgroundTasks, admin: AdminUser, db: DbDep) -> Map:
    m = db.get(Map, map_id)
    if m is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    if not m.source_url:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Keine Quell-URL hinterlegt")
    m.status = "importing"
    db.commit()
    bg.add_task(run_import, map_id, m.source_url)
    return m


@router.delete("/{map_id}")
def delete_map(map_id: str, admin: AdminUser, db: DbDep) -> None:
    m = db.get(Map, map_id)
    if m is None:
        return
    in_use = db.scalar(select(Plan.id).where(Plan.map_id == map_id, Plan.deleted_at.is_(None)))
    if in_use:
        raise HTTPException(status.HTTP_409_CONFLICT, "Karte wird von Plänen genutzt")
    db.delete(m)
    db.commit()
    d = map_dir(map_id)
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)
