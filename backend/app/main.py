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
from starlette.middleware.sessions import SessionMiddleware

from . import __version__
from .bootstrap import ensure_bootstrap_admin, init_db
from .config import get_settings
from .routers import admin, auth, catalog, favorites, live, maps, plans, public, tiles
from .services.realtime import hub

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("sidc")

FRONTEND_DIST = Path(__file__).resolve().parent / "static"
_settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    _settings.maps_dir.mkdir(parents=True, exist_ok=True)
    _settings.uploads_dir.mkdir(parents=True, exist_ok=True)
    init_db()
    ensure_bootstrap_admin()
    await hub.start()
    log.info("SIDC-C2 %s bereit", __version__)
    yield
    await hub.stop()


app = FastAPI(title="SIDC – C2 – Command & Control", version=__version__, lifespan=lifespan)
# Von authlib für den OIDC-State gebraucht; Cookie ist mit SECRET_KEY signiert.
app.add_middleware(SessionMiddleware, secret_key=_settings.resolved_secret_key(), same_site="lax")

app.include_router(auth.router)
app.include_router(maps.router)
app.include_router(tiles.router)
app.include_router(plans.router)
app.include_router(plans.folders_router)
app.include_router(admin.router)
app.include_router(catalog.router)
app.include_router(favorites.router)
app.include_router(public.router)
app.add_api_websocket_route("/plans/{plan_id}/live", live.live_ws)


@app.get("/healthz")
async def healthz() -> JSONResponse:
    return JSONResponse({"status": "ok", "version": __version__})


if FRONTEND_DIST.is_dir():
    _assets = FRONTEND_DIST / "assets"
    if _assets.is_dir():
        app.mount("/assets", StaticFiles(directory=_assets), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str) -> FileResponse:
        candidate = FRONTEND_DIST / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")
