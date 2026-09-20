"""Client-API für lokale Clients (Bearer-Token, Scope ``maps:read``).

Ein Token ist ausschließlich für Lesezugriff auf Kartendaten gedacht: die vorhandenen
Karten-Routen (``GET /api/maps``, ``/api/maps/{id}/tiles/…``, ``style.json``, ``topo.geojson``,
``locations.json``, ``contours.geojson``, ``peaks.geojson``) akzeptieren zusätzlich zur
Cookie-Session einen ``Authorization: Bearer``-Token. Pläne, Marker, Zeichnungen, Admin und
Token-Verwaltung bleiben Cookie-only — ein Token kommt dort nie durch.

Kartenzugriff ist bewusst NICHT pro Nutzer eingeschränkt: Karten stehen jedem angemeldeten
Nutzer zu.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from .. import __version__
from ..deps import MapsReader
from ..ratelimit import hit_limit

router = APIRouter(prefix="/api/client", tags=["client"])

PROTOCOL = 2  # 1 war das (verworfene) Client-Pack-Format
_PING_LIMIT = 60


@router.get("/ping")
def ping(auth: MapsReader) -> dict:
    """Verbindungstest: gültiger Token? Wer? Welche Protokollversion?"""
    who = f"t:{auth.token.id}" if auth.token else f"u:{auth.user.id}"
    if not hit_limit(f"client:ping:{who}", _PING_LIMIT, 60):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Zu viele Anfragen")
    return {
        "server": "SIDC C2",
        "version": __version__,
        "protocol": PROTOCOL,
        "user": {"label": auth.user.label},
        "token": (
            {"name": auth.token.name, "scopes": list(auth.token.scopes or [])} if auth.token else None
        ),
    }
