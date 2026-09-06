"""Einstiegspunkt. Serviert API + gebautes Frontend auf einem Port (Default 8080).

Der externe Reverse Proxy (Nginx Proxy Manager) terminiert TLS und leitet auf diesen
Port weiter — deshalb kein Proxy-Container im Stack und keine CORS-Freigaben nötig
(alles same-origin).
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .config import get_settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("sidc")

FRONTEND_DIST = Path(__file__).resolve().parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    settings.maps_dir.mkdir(parents=True, exist_ok=True)
    settings.uploads_dir.mkdir(parents=True, exist_ok=True)
    _ = settings.resolved_secret_key()  # beim ersten Start generieren/persistieren
    log.info("SIDC-C2 %s gestartet (maps=%s)", __version__, settings.maps_dir)
    # TODO Phase 1/2: DB-Migrationen ausführen, Bootstrap-Admin anlegen, Redis verbinden
    yield


app = FastAPI(title="SIDC – C2 – Command & Control", version=__version__, lifespan=lifespan)


@app.get("/healthz")
async def healthz() -> JSONResponse:
    return JSONResponse({"status": "ok", "version": __version__})


# TODO Phase 2+: app.include_router(auth.router), maps.router, plans.router, live.router

if FRONTEND_DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str) -> FileResponse:
        """SPA-Routing: alles Nicht-API auf index.html."""
        candidate = FRONTEND_DIST / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")
