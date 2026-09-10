"""Login/Logout: lokal (Username/Passwort) + optional externes OIDC.

Vorbild: Arma-Reforger-Mod-Manager — lokaler Login bleibt aktiv, auch wenn OIDC an
ist; unbekannte OIDC-User werden als Rolle 'user' angelegt.
"""
from __future__ import annotations

import logging

from authlib.integrations.starlette_client import OAuth
from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel
from sqlalchemy import select

from .. import audit
from ..config import get_settings
from ..deps import CurrentUser, DbDep
from ..models import OidcIdentity, User
from ..permissions import can_create_plans
from ..ratelimit import check_and_hit, reset
from ..schemas import LoginIn, MeOut
from ..security import (
    SESSION_COOKIE,
    cookie_is_secure,
    hash_password,
    issue_session,
    verify_password,
)

log = logging.getLogger("sidc.auth")
router = APIRouter(prefix="/auth", tags=["auth"])
_settings = get_settings()

# Fester Hash für den Timing-Ausgleich bei unbekanntem Benutzer (siehe login()).
_DUMMY_HASH = hash_password("sidc-timing-equalizer-not-a-real-password")

_oauth = OAuth()
_OIDC_READY = bool(_settings.oidc_enabled and _settings.oidc_issuer)
if _OIDC_READY:
    _oauth.register(
        name="oidc",
        client_id=_settings.oidc_client_id,
        client_secret=_settings.oidc_client_secret,
        server_metadata_url=f"{_settings.oidc_issuer.rstrip('/')}/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile"},
    )


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _set_session_cookie(request: Request, response: Response, user: User) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        issue_session(user.id, user.session_epoch or 0),
        max_age=_settings.session_ttl_days * 86400,
        httponly=True,
        samesite="lax",
        secure=cookie_is_secure(request.url.scheme, request.headers.get("x-forwarded-proto")),
        path="/",
    )


@router.post("/login", response_model=MeOut)
def login(body: LoginIn, request: Request, response: Response, db: DbDep) -> MeOut:
    ip = _client_ip(request)
    key = f"{ip}:{body.username.lower()}"
    if not check_and_hit(key, ip):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Zu viele Fehlversuche, kurz warten")

    user = db.scalar(select(User).where(User.username == body.username))
    # Immer ein Argon2-Verify rechnen (auch bei unbekanntem oder OIDC-only-User),
    # damit die Antwortzeit keine Benutzer-Existenz verrät.
    if user and user.password_hash:
        ok = verify_password(body.password, user.password_hash)
    else:
        verify_password(body.password, _DUMMY_HASH)
        ok = False
    if user is None or not user.is_active or not ok:
        audit.record(db, "login.fail", request=request, username=body.username)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Login fehlgeschlagen")

    reset(key)
    _set_session_cookie(request, response, user)
    audit.record(db, "login.ok", user_id=user.id, request=request)
    return _me(db, user)


@router.post("/logout")
def logout(request: Request, response: Response, db: DbDep) -> dict:
    token = request.cookies.get(SESSION_COOKIE)
    from ..security import read_session

    sess = read_session(token) if token else None
    response.delete_cookie(SESSION_COOKIE, path="/")
    if sess:
        audit.record(db, "logout", user_id=sess[0], request=request)
    return {"ok": True}


@router.get("/me", response_model=MeOut)
def me(user: CurrentUser, db: DbDep) -> MeOut:
    return _me(db, user)


class ProfileIn(BaseModel):
    display_name: str = ""


@router.patch("/me", response_model=MeOut)
def patch_my_profile(body: ProfileIn, user: CurrentUser, db: DbDep) -> MeOut:
    name = "".join(c for c in (body.display_name or "").strip() if c.isprintable())[:64]
    user.display_name = name
    db.commit()
    return _me(db, user)


_UI_SETTINGS_KEYS = {"keybinds", "theme", "lang"}
_UI_SETTINGS_MAX_BYTES = 8192


@router.patch("/me/settings", response_model=MeOut)
def patch_my_settings(body: dict, user: CurrentUser, db: DbDep) -> MeOut:
    import json

    incoming = {k: v for k, v in (body or {}).items() if k in _UI_SETTINGS_KEYS}
    cur = dict(user.ui_settings or {})
    cur.update(incoming)
    if len(json.dumps(cur)) > _UI_SETTINGS_MAX_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Einstellungen zu groß")
    user.ui_settings = cur
    db.commit()
    return _me(db, user)


def _me(db: DbDep, user: User) -> MeOut:
    from ..permissions import effective_mission_builder

    return MeOut(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        role=user.role,
        can_create_plans=user.can_create_plans,
        is_mission_builder=user.is_mission_builder,
        can_create_plans_effective=can_create_plans(db, user),
        is_mission_builder_effective=effective_mission_builder(db, user),
        ui_settings=user.ui_settings or {},
    )


# ─── OIDC ──────────────────────────────────────────────────────────────────

@router.get("/oidc/enabled")
def oidc_enabled() -> dict:
    return {"enabled": _OIDC_READY}


@router.get("/oidc/login")
async def oidc_login(request: Request):
    if not _OIDC_READY:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "OIDC ist nicht konfiguriert")
    redirect_uri = _settings.oidc_redirect_url or str(request.url_for("oidc_callback"))
    return await _oauth.oidc.authorize_redirect(request, redirect_uri)


@router.get("/oidc/callback", name="oidc_callback")
async def oidc_callback(request: Request, response: Response, db: DbDep):
    if not _OIDC_READY:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "OIDC ist nicht konfiguriert")
    token = await _oauth.oidc.authorize_access_token(request)
    claims = token.get("userinfo") or {}
    issuer = claims.get("iss") or _settings.oidc_issuer
    subject = claims.get("sub")
    if not subject:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "OIDC-Token ohne 'sub'")

    identity = db.scalar(
        select(OidcIdentity).where(
            OidcIdentity.issuer == issuer, OidcIdentity.subject == subject
        )
    )
    if identity is not None:
        user = db.get(User, identity.user_id)
    else:
        username = _unique_username(db, claims.get("preferred_username") or claims.get("email") or f"oidc-{subject[:8]}")
        user = User(username=username, role="user", can_create_plans=False)
        db.add(user)
        db.flush()
        db.add(OidcIdentity(user_id=user.id, issuer=issuer, subject=subject))
        from ..permissions import assign_default_group

        assign_default_group(db, user.id)
        db.commit()
        log.info("OIDC-User '%s' angelegt", username)

    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Konto deaktiviert")

    _set_session_cookie(request, response, user)
    # Nach dem Login zurück auf die App
    response.status_code = status.HTTP_303_SEE_OTHER
    response.headers["location"] = "/"
    return response


def _unique_username(db: DbDep, base: str) -> str:
    base = base.split("@")[0][:56] or "user"
    name = base
    i = 1
    while db.scalar(select(User.id).where(User.username == name)):
        i += 1
        name = f"{base}-{i}"
    return name


__all__ = ["router", "hash_password"]
