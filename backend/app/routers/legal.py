"""Impressum/Datenschutz: vom Admin als .md/.txt hochgeladener Text, persistent
unter dem uploads-Volume abgelegt. Lesen ist bewusst ohne Login möglich — diese
Seiten müssen laut Gesetz jederzeit erreichbar sein.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status

from .. import audit
from ..config import get_settings
from ..deps import AdminUser, DbDep

router = APIRouter(prefix="/api", tags=["legal"])
_settings = get_settings()

PAGES = {"imprint": "impressum.md", "privacy": "datenschutz.md"}
_MAX_BYTES = 1 * 1024 * 1024


def _dir():
    d = _settings.uploads_dir / "legal"
    d.mkdir(parents=True, exist_ok=True)
    return d


@router.get("/legal/{page}")
def get_legal(page: str) -> dict:
    if page not in PAGES:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unbekannte Seite")
    p = _dir() / PAGES[page]
    if not p.is_file():
        return {"content": None}
    return {"content": p.read_text(encoding="utf-8")}


@router.post("/admin/legal/{page}")
async def upload_legal(page: str, request: Request, admin: AdminUser, db: DbDep) -> dict:
    """Roher Text-Body (.md oder .txt, als UTF-8) — kein Multipart."""
    if page not in PAGES:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unbekannte Seite")
    raw = await request.body()
    if len(raw) > _MAX_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Datei zu groß")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Datei ist kein gültiges UTF-8") from exc
    (_dir() / PAGES[page]).write_text(text, encoding="utf-8")
    audit.record(db, "legal.upload", user_id=admin.id, target_type="legal", target_id=page,
                 request=request, bytes=len(raw))
    return {"ok": True, "page": page, "bytes": len(raw)}


@router.delete("/admin/legal/{page}")
def delete_legal(page: str, request: Request, admin: AdminUser, db: DbDep) -> dict:
    if page not in PAGES:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unbekannte Seite")
    (_dir() / PAGES[page]).unlink(missing_ok=True)
    audit.record(db, "legal.delete", user_id=admin.id, target_type="legal", target_id=page,
                 request=request)
    return {"ok": True}
