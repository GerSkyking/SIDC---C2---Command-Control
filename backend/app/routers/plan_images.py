"""Plan-Bilder: Upload (BLOB in der DB), Auslieferung, Auflistung.

Bearbeiten/Löschen/Platzieren laufen — wie bei Annotationen — über den
WebSocket (`image.move` / `image.modify` / `image.delete` in ``live.py``).
"""
from __future__ import annotations

import struct
from typing import Annotated
from urllib.parse import unquote

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import Response
from sqlalchemy import select
from starlette.concurrency import run_in_threadpool

from ..config import get_settings
from ..deps import CurrentUser, DbDep, require_plan_level
from ..models import Plan, PlanImage
from ..permissions import effective_mission_builder
from ..services.realtime import hub
from .live import _create_image, _image_out, _phase_is_builder

router = APIRouter(prefix="/plans", tags=["plan-images"])
_settings = get_settings()

EditorPlan = Annotated[Plan, Depends(require_plan_level("editor"))]
ViewerPlan = Annotated[Plan, Depends(require_plan_level("viewer"))]

_ALLOWED = {"image/png", "image/jpeg", "image/gif", "image/webp"}


def _sniff(raw: bytes) -> tuple[str, int, int] | None:
    """(content_type, width, height) für PNG/JPEG/GIF/WebP — reine Stdlib.
    Bei erkanntem Typ aber unparsbaren Maßen: (typ, 0, 0)."""
    try:
        if raw[:8] == b"\x89PNG\r\n\x1a\n" and raw[12:16] == b"IHDR":
            w, h = struct.unpack(">II", raw[16:24])
            return "image/png", w, h
        if raw[:6] in (b"GIF87a", b"GIF89a"):
            w, h = struct.unpack("<HH", raw[6:10])
            return "image/gif", w, h
        if raw[:2] == b"\xff\xd8":
            i, n = 2, len(raw)
            while i + 9 < n:
                if raw[i] != 0xFF:
                    i += 1
                    continue
                m = raw[i + 1]
                if m in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                    h, w = struct.unpack(">HH", raw[i + 5:i + 9])
                    return "image/jpeg", w, h
                if m in (0xD8, 0xD9) or 0xD0 <= m <= 0xD7:
                    i += 2
                    continue
                seg = struct.unpack(">H", raw[i + 2:i + 4])[0]
                i += 2 + seg
            return "image/jpeg", 0, 0
        if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
            fmt = raw[12:16]
            if fmt == b"VP8 ":
                w = struct.unpack("<H", raw[26:28])[0] & 0x3FFF
                h = struct.unpack("<H", raw[28:30])[0] & 0x3FFF
                return "image/webp", w, h
            if fmt == b"VP8L":
                b0, b1, b2, b3 = raw[21], raw[22], raw[23], raw[24]
                w = 1 + (((b1 & 0x3F) << 8) | b0)
                h = 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6))
                return "image/webp", w, h
            if fmt == b"VP8X":
                w = 1 + (raw[24] | (raw[25] << 8) | (raw[26] << 16))
                h = 1 + (raw[27] | (raw[28] << 8) | (raw[29] << 16))
                return "image/webp", w, h
            return "image/webp", 0, 0
    except (struct.error, IndexError):
        return None
    return None


@router.post("/{plan_id}/images", status_code=status.HTTP_201_CREATED)
async def upload_image(
    plan: EditorPlan, request: Request, user: CurrentUser, db: DbDep,
    phase_id: str = "", caption: str = "", w: int = 0, h: int = 0,
) -> dict:
    raw = await request.body()
    if not raw:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Leerer Upload")
    if len(raw) > _settings.image_max_mb * 1024 * 1024:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Bild zu groß")
    sniff = _sniff(raw)
    if sniff is None or sniff[0] not in _ALLOWED:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nur PNG, JPEG, GIF oder WebP")
    ct, sw, sh = sniff
    if (sw == 0 or sh == 0) and w > 0 and h > 0:
        sniff = (ct, max(1, min(w, 20000)), max(1, min(h, 20000)))

    pid = phase_id or None
    if pid and not effective_mission_builder(db, user) and _phase_is_builder(plan.id, pid):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Missionsbau-Ebene")

    fname = unquote(request.headers.get("x-filename", ""))[:255]
    meta = {"phase_id": pid, "caption": caption, "filename": fname}
    out = await run_in_threadpool(_create_image, plan.id, user.id, meta, raw, sniff)
    await hub.broadcast(
        plan.id, {"type": "image.upsert", "image": out}, builder_only=_phase_is_builder(plan.id, pid)
    )
    return out


@router.get("/{plan_id}/images")
def list_images(plan: ViewerPlan, db: DbDep) -> list[dict]:
    return [
        _image_out(i)
        for i in db.scalars(select(PlanImage).where(PlanImage.plan_id == plan.id).order_by(PlanImage.created_at))
    ]


@router.get("/{plan_id}/images/{image_id}/raw")
def image_raw(plan: ViewerPlan, image_id: str, db: DbDep) -> Response:
    i = db.get(PlanImage, image_id)
    if i is None or i.plan_id != plan.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    return Response(
        i.data, media_type=i.content_type,
        headers={"Cache-Control": "private, max-age=300"},
    )


__all__ = ["router", "_sniff"]
