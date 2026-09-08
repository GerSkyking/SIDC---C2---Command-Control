"""Externe Karten-Bezugsquellen (Gitea-Repo). Admin trägt eine Repo-URL ein,
das Backend listet die ``*.zip`` über die Gitea-Contents-API. Der eigentliche
Import läuft über den vorhandenen ``run_import``-Weg (Streaming auf Platte).
"""
from __future__ import annotations

from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select

from .. import audit
from ..deps import AdminUser, DbDep
from ..models import MapSource
from ..schemas import MapSourceFile, MapSourceIn, MapSourceOut

router = APIRouter(prefix="/api/map-sources", tags=["map-sources"])


def _parse_repo_url(url: str) -> tuple[str, str]:
    """``https://git.jensr.de/root/ReforgerMapData`` → (``https://git.jensr.de``,
    ``root/ReforgerMapData``)."""
    u = urlparse(url.strip().rstrip("/"))
    if not u.scheme or not u.netloc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ungültige Repo-URL")
    parts = [p for p in u.path.split("/") if p]
    if len(parts) < 2:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "URL muss owner/repo enthalten")
    return f"{u.scheme}://{u.netloc}", f"{parts[0]}/{parts[1]}"


def _out(s: MapSource) -> MapSourceOut:
    return MapSourceOut(
        id=s.id, kind=s.kind, name=s.name, base_url=s.base_url, repo=s.repo,
        subpath=s.subpath, ref=s.ref, has_token=bool(s.token),
    )


def _headers(s: MapSource) -> dict:
    return {"Authorization": f"token {s.token}"} if s.token else {}


def _list_files(s: MapSource) -> list[MapSourceFile]:
    path = s.subpath.strip("/")
    api = f"{s.base_url}/api/v1/repos/{s.repo}/contents/{path}".rstrip("/")
    params = {"ref": s.ref} if s.ref else None
    try:
        r = httpx.get(api, headers=_headers(s), params=params, timeout=20, follow_redirects=True)
        r.raise_for_status()
        data = r.json()
    except httpx.HTTPError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Gitea nicht erreichbar: {exc}")
    if not isinstance(data, list):
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Unerwartete Gitea-Antwort")
    out: list[MapSourceFile] = []
    for e in data:
        if e.get("type") == "file" and str(e.get("name", "")).lower().endswith(".zip"):
            out.append(MapSourceFile(
                name=e["name"], size=int(e.get("size") or 0),
                download_url=e.get("download_url") or "",
            ))
    return sorted(out, key=lambda f: f.name)


@router.get("", response_model=list[MapSourceOut])
def list_sources(admin: AdminUser, db: DbDep) -> list[MapSourceOut]:
    return [_out(s) for s in db.scalars(select(MapSource).order_by(MapSource.created_at))]


@router.post("", response_model=MapSourceOut, status_code=status.HTTP_201_CREATED)
def create_source(body: MapSourceIn, request: Request, admin: AdminUser, db: DbDep) -> MapSourceOut:
    base_url, repo = _parse_repo_url(body.url)
    s = MapSource(
        kind="gitea", name=body.name or repo, base_url=base_url, repo=repo,
        subpath=body.subpath.strip("/"), ref=body.ref.strip(),
        token=(body.token or None), created_by=admin.id,
    )
    db.add(s)
    db.commit()
    audit.record(db, "mapsource.create", user_id=admin.id, target_type="map_source",
                 target_id=s.id, request=request, repo=repo)
    return _out(s)


@router.delete("/{source_id}")
def delete_source(source_id: str, request: Request, admin: AdminUser, db: DbDep) -> dict:
    s = db.get(MapSource, source_id)
    if s is not None:
        db.delete(s)
        db.commit()
        audit.record(db, "mapsource.delete", user_id=admin.id, target_type="map_source",
                     target_id=source_id, request=request)
    return {"ok": True}


@router.get("/{source_id}/files", response_model=list[MapSourceFile])
def source_files(source_id: str, admin: AdminUser, db: DbDep) -> list[MapSourceFile]:
    s = db.get(MapSource, source_id)
    if s is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    return _list_files(s)
