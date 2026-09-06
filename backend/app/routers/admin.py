"""Admin-Serviceaktionen."""
from __future__ import annotations

import asyncio
import logging
import os
import signal

from fastapi import APIRouter

from ..deps import AdminUser

log = logging.getLogger("sidc.admin")
router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.post("/restart")
async def restart_backend(admin: AdminUser) -> dict:
    """Beendet den Backend-Prozess; Docker (`restart: unless-stopped`) startet den
    Container neu. db/redis laufen weiter. ~2 s Ausfall."""
    log.warning("Neustart durch Admin '%s' ausgelöst", admin.username)

    async def _bye() -> None:
        await asyncio.sleep(0.3)  # Response noch rausschicken
        os.kill(os.getpid(), signal.SIGTERM)

    asyncio.create_task(_bye())
    return {"ok": True, "message": "Backend startet neu"}
