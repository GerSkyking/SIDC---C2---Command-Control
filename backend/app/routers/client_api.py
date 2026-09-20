"""Client-API für den lokalen SkyMap-X-Client (Bearer-Token, Scope ``maps:read``).

Liefert ausschließlich Kartendaten (Client-Pack im Kachelformat der lokalen App). Pläne,
Marker und Zeichnungen sind über diese Routen nicht erreichbar — und ein API-Token
funktioniert ausschließlich hier (alle anderen Routen sind Cookie-only).

Kartenzugriff ist bewusst NICHT pro Nutzer eingeschränkt: Karten stehen jedem
angemeldeten Nutzer zu.
"""
from __future__ import annotations

import mimetypes
import re
import shutil
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from sqlalchemy import select

from .. import __version__, audit
from ..config import get_settings
from ..deps import AdminUser, ClientAuth, DbDep, require_client_scope
from ..models import Map
from ..ratelimit import hit_limit
from ..services import client_pack
from ..tokens import SCOPE_MAPS_READ

router = APIRouter(prefix="/api/client", tags=["client"])
admin_router = APIRouter(prefix="/api/maps/{map_id}/client-pack", tags=["client"])
_settings = get_settings()

PROTOCOL = 1
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,63}$")

# Limits pro Token/Nutzer und Minute. Eine Karte scrollend braucht ein paar Dutzend
# Kacheln; das Limit bremst nur Massen-Scraping.
_PING_LIMIT = 60
_FILE_LIMIT = 6000

# webp/bin sind nicht in jeder mimetypes-Tabelle
_MEDIA = {".webp": "image/webp", ".bin": "application/octet-stream", ".json": "application/json"}

ClientAuthDep = Annotated[ClientAuth, Depends(require_client_scope(SCOPE_MAPS_READ))]


def _limit_key(auth: ClientAuth, what: str) -> str:
    who = f"t:{auth.token.id}" if auth.token else f"u:{auth.user.id}"
    return f"client:{what}:{who}"


@router.get("/ping")
def ping(auth: ClientAuthDep, db: DbDep) -> dict:
    """Verbindungstest + Karten, für die ein Client-Pack vorliegt."""
    if not hit_limit(_limit_key(auth, "ping"), _PING_LIMIT, 60):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Zu viele Anfragen")
    maps = []
    for m in db.scalars(select(Map).order_by(Map.name)):
        info = client_pack.read_info(m.id)
        if info is None:
            continue
        maps.append({"id": m.id, "name": m.name, "client_pack": info})
    return {
        "server": "SIDC C2",
        "version": __version__,
        "protocol": PROTOCOL,
        "user": {"label": auth.user.label},
        "token": (
            {"name": auth.token.name, "scopes": list(auth.token.scopes or [])} if auth.token else None
        ),
        "maps": maps,
    }


@router.get("/maps/{map_id}/files/{path:path}")
def get_file(map_id: str, path: str, auth: ClientAuthDep) -> FileResponse:
    if not hit_limit(_limit_key(auth, "files"), _FILE_LIMIT, 60):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Zu viele Anfragen")
    target = client_pack.resolve_file(map_id, path)
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    media = _MEDIA.get(target.suffix.lower()) or mimetypes.guess_type(target.name)[0]
    return FileResponse(
        target, media_type=media or "application/octet-stream",
        headers={"Cache-Control": "private, max-age=86400"},
    )


# ─── Admin: Client-Pack hochladen / löschen ──────────────────────────────────

@admin_router.post("")
async def upload_client_pack(map_id: str, request: Request, admin: AdminUser, db: DbDep) -> dict:
    """Rohen ZIP-Body streamen (Export aus dem lokalen SkyMap-X-Tool)."""
    if not _ID_RE.match(map_id) or db.get(Map, map_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Karte nicht gefunden")

    tmp = _settings.maps_dir / f".clientpack_{map_id}.zip"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    limit = _settings.map_import_max_mb * 1024 * 1024
    written = 0
    try:
        with tmp.open("wb") as f:
            async for chunk in request.stream():
                written += len(chunk)
                if written > limit:
                    raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Datei zu groß")
                f.write(chunk)
        if written == 0:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Leerer Upload")
        try:
            info = await run_in_threadpool(client_pack.install_pack, map_id, tmp)
        except client_pack.ClientPackError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    finally:
        tmp.unlink(missing_ok=True)

    audit.record(db, "client_pack.upload", user_id=admin.id, target_type="map", target_id=map_id,
                 request=request, bytes=written, version=info["version"])
    return info


@admin_router.get("")
def client_pack_info(map_id: str, admin: AdminUser) -> dict:
    return {"client_pack": client_pack.read_info(map_id)}


@admin_router.delete("")
def delete_client_pack(map_id: str, request: Request, admin: AdminUser, db: DbDep) -> dict:
    client_pack.delete_pack(map_id)
    shutil.rmtree(client_pack._tmp_dir(map_id), ignore_errors=True)  # noqa: SLF001
    audit.record(db, "client_pack.delete", user_id=admin.id, target_type="map", target_id=map_id,
                 request=request)
    return {"ok": True}
