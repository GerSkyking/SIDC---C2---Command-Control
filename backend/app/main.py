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
from .routers import (
    admin,
    auth,
    catalog,
    favorites,
    live,
    map_sources,
    maps,
    orbat,
    plan_images,
    plans,
    public,
    tiles,
)
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
app.add_middleware(
    SessionMiddleware,
    secret_key=_settings.resolved_secret_key(),
    same_site="lax",
    https_only=_settings.cookie_secure != "false",
    max_age=600,  # nur der kurzlebige OIDC-Login-Flow
)

# Content-Security-Policy: mit MapLibre-GL kompatibel (Worker aus blob:, SVG-Icons
# als data:). Kein externes Script/CSS — alles wird gebündelt ausgeliefert.
_CSP = (
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; "
    "form-action 'self'; img-src 'self' data: blob:; worker-src 'self' blob:; "
    "child-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
    "connect-src 'self'; font-src 'self' data:"
)
_SECURITY_HEADERS = {
    "Content-Security-Policy": _CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Strict-Transport-Security": "max-age=31536000",
}


@app.middleware("http")
async def security_headers(request, call_next):
    resp = await call_next(request)
    for k, v in _SECURITY_HEADERS.items():
        resp.headers.setdefault(k, v)
    return resp

app.include_router(auth.router)
app.include_router(maps.router)
app.include_router(map_sources.router)
app.include_router(tiles.router)
app.include_router(plans.router)
app.include_router(plans.folders_router)
app.include_router(plan_images.router)
app.include_router(orbat.router)
app.include_router(orbat.plan_orbat_router)
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

    _DIST_ROOT = FRONTEND_DIST.resolve()

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str) -> FileResponse:
        if full_path:
            candidate = (_DIST_ROOT / full_path).resolve()
            # Kein Ausbruch aus dem Static-Verzeichnis (z. B. via %2e%2e%2f -> ../).
            if candidate.is_file() and candidate.is_relative_to(_DIST_ROOT):
                return FileResponse(candidate)
        return FileResponse(_DIST_ROOT / "index.html")
