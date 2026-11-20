"""Login/Logout: lokal (Username/Passwort) + optional externes OIDC.

Vorbild: Arma-Reforger-Mod-Manager — lokaler Login bleibt aktiv, auch wenn OIDC an
ist; unbekannte OIDC-User werden als Rolle 'user' angelegt.

Regeln: docs/specs/anmeldung-und-zugriff.md (AUTH-R-…). Zugangsgruppe, Rechte aus Gruppen,
Notfallzugang und Sitzungsdauer sind Einstellungen; ohne sie gilt das Verhalten oben.
"""
from __future__ import annotations

import json
import logging
import tempfile
import zipfile
from datetime import datetime

from authlib.integrations.starlette_client import OAuth, OAuthError
from authlib.jose.errors import JoseError
from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import RedirectResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import defer

from .. import audit, oidc_access
from ..config import get_settings
from ..deps import CurrentUser, DbDep
from ..models import (
    Annotation,
    ApiToken,
    AuditLog,
    Favorite,
    Marker,
    OidcIdentity,
    Plan,
    PlanACL,
    PlanImage,
    PlanVersion,
    PublicShare,
    Stroke,
    User,
    now,
)
from ..permissions import can_create_plans
from ..ratelimit import check_and_hit, reset
from ..schemas import LoginIn, MeOut
from ..security import (
    SESSION_COOKIE,
    hash_password,
    read_session,
    set_session_cookie,
    verify_password,
)

log = logging.getLogger("sidc.auth")
router = APIRouter(prefix="/auth", tags=["auth"])
_settings = get_settings()

# Fester Hash für den Timing-Ausgleich bei unbekanntem Benutzer (siehe login()).
_DUMMY_HASH = hash_password("sidc-timing-equalizer-not-a-real-password")

def _register_oidc(oauth: OAuth, settings) -> None:
    """Den Provider aus den Einstellungen registrieren. Angefordert werden genau die Scopes
    aus ``OIDC_SCOPES`` (AUTH-R-006); ``state`` und ``nonce`` setzt und prüft authlib (AUTH-R-011)."""
    oauth.register(
        name="oidc",
        client_id=settings.oidc_client_id,
        client_secret=settings.oidc_client_secret,
        server_metadata_url=f"{settings.oidc_issuer.rstrip('/')}/.well-known/openid-configuration",
        client_kwargs={"scope": " ".join(settings.oidc_scopes.split())},
    )


_oauth = OAuth()
_OIDC_READY = bool(_settings.oidc_enabled and _settings.oidc_issuer)
if _OIDC_READY:
    _register_oidc(_oauth, _settings)

# Kurzlebige Sitzung des OIDC-Ablaufs (SessionMiddleware): Verknüpfungscode (AUTH-R-014).
_LINK_SESSION_KEY = "oidc_link"


def oidc_ready() -> bool:
    return _OIDC_READY


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _set_session_cookie(request: Request, response: Response, user: User) -> None:
    set_session_cookie(request, response, user.id, user.session_epoch or 0)


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
    # AUTH-R-002: Als Notfallzugang nimmt der lokale Login nur den Start-Admin an. Die Prüfung
    # steht nach dem Argon2-Verify, damit Antwort und Antwortzeit für alle anderen gleich bleiben.
    is_bootstrap = user is not None and oidc_access.is_bootstrap_admin(user)
    if _settings.local_login == "bootstrap-admin" and not is_bootstrap:
        ok = False
    # Ein Konto mit OIDC-Identität meldet sich nur über den Provider an; sonst gingen
    # Zugangsprüfung und Abgleich (AUTH-R-003, -008) am lokalen Passwort vorbei. Ausnahme
    # ist der Start-Admin als Notfallzugang.
    if user is not None and not is_bootstrap and oidc_access.has_identity(db, user.id):
        ok = False
    if user is None or not user.is_active or not ok:
        audit.record(db, "login.fail", request=request, username=body.username)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Login fehlgeschlagen")

    reset(key)
    _set_session_cookie(request, response, user)
    audit.record(db, "login.ok", user_id=user.id, request=request, method="local")
    return _me(db, user)


@router.post("/logout")
def logout(request: Request, response: Response, db: DbDep) -> dict:
    token = request.cookies.get(SESSION_COOKIE)
    sess = read_session(token) if token else None
    response.delete_cookie(SESSION_COOKIE, path="/")
    if sess:
        # Nur dieses Cookie wird gelöscht. Die Session-Epoche bleibt unberührt, damit andere
        # Geräte (z. B. Desktop-App) angemeldet bleiben; sie steigt nur bei Passwortwechsel/Admin-Reset.
        audit.record(db, "logout", user_id=sess[0], request=request)
    return {"ok": True}


@router.get("/me", response_model=MeOut)
def me(user: CurrentUser, db: DbDep) -> MeOut:
    return _me(db, user)


_NAME_FORBIDDEN = frozenset("<>\"'`&")  # Anzeigename landet in HTML-Kontexten anderer Nutzer


class ProfileIn(BaseModel):
    display_name: str = ""


@router.patch("/me", response_model=MeOut)
def patch_my_profile(body: ProfileIn, user: CurrentUser, db: DbDep) -> MeOut:
    if name_locked(db, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Anzeigename kommt aus dem Identity-Provider")
    name = "".join(c for c in (body.display_name or "").strip() if c.isprintable() and c not in _NAME_FORBIDDEN)[:64]
    user.display_name = name
    db.commit()
    return _me(db, user)


_UI_SETTINGS_KEYS = {"keybinds", "theme", "lang", "map", "topbar_scale", "last_project", "panels"}
_UI_SETTINGS_MAX_BYTES = 16384


@router.patch("/me/settings", response_model=MeOut)
def patch_my_settings(body: dict, user: CurrentUser, db: DbDep) -> MeOut:
    import json

    incoming = {k: v for k, v in (body or {}).items() if k in _UI_SETTINGS_KEYS}
    if "panels" in incoming:  # Box-Positionen: Schlüssel -> JSON-Text, nur kleine Strings
        pn = incoming["panels"]
        if not isinstance(pn, dict) or any(
            not isinstance(k, str) or len(k) > 64 or not isinstance(v, str) or len(v) > 200 for k, v in pn.items()
        ) or len(pn) > 120:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Ungültige Panel-Einstellungen")
    cur = dict(user.ui_settings or {})
    cur.update(incoming)
    if len(json.dumps(cur)) > _UI_SETTINGS_MAX_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Einstellungen zu groß")
    user.ui_settings = cur
    db.commit()
    return _me(db, user)


# ─── DSGVO: eigenes Konto löschen / eigene Daten exportieren ──────────────

def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


@router.get("/me/export")
def export_my_data(user: CurrentUser, db: DbDep) -> StreamingResponse:
    """Alle personenbezogenen Daten als ZIP (Recht auf Datenübertragbarkeit)."""
    plan_names = {p.id: p.name for p in db.scalars(select(Plan))}

    profile = {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "role": user.role,
        "can_create_plans": user.can_create_plans,
        "is_mission_builder": user.is_mission_builder,
        "is_zeus": user.is_zeus,
        "is_technician": user.is_technician,
        "can_manage_maps": user.can_manage_maps,
        "is_active": user.is_active,
        "created_at": _iso(user.created_at),
        "ui_settings": user.ui_settings or {},
        "groups": [g.name for g in user.groups],
    }

    favorites = [
        {
            "label": f.label, "sidc": f.sidc, "unit_text": f.unit_text, "ai_text": f.ai_text,
            "channel": f.channel, "created_at": _iso(f.created_at),
        }
        for f in db.scalars(select(Favorite).where(Favorite.user_id == user.id))
    ]

    plan_access = [
        {
            "plan_id": a.plan_id, "plan_name": plan_names.get(a.plan_id, "—"), "level": a.level,
        }
        for a in db.scalars(select(PlanACL).where(PlanACL.subject_type == "user", PlanACL.subject_id == user.id))
    ]

    plans_created = [
        {"id": p.id, "name": p.name, "created_at": _iso(p.created_at)}
        for p in db.scalars(select(Plan).where(Plan.created_by == user.id))
    ]

    def _content(model, extra):
        return [
            {"id": r.id, "plan_id": r.plan_id, "plan_name": plan_names.get(r.plan_id, "—"),
             "created_at": _iso(r.created_at), **extra(r)}
            for r in db.scalars(select(model).where(model.created_by == user.id))
        ]

    markers = _content(Marker, lambda r: {"sidc": r.sidc, "unit_text": r.unit_text})
    annotations = _content(Annotation, lambda r: {"text": r.text})
    strokes = _content(Stroke, lambda r: {"kind": r.kind, "points": r.points})
    plan_versions = _content(PlanVersion, lambda r: {"label": r.label})
    public_shares = [
        {"token": s.token, "plan_id": s.plan_id, "plan_name": plan_names.get(s.plan_id, "—"),
         "label": s.label, "created_at": _iso(s.created_at)}
        for s in db.scalars(select(PublicShare).where(PublicShare.created_by == user.id))
    ]
    images = list(db.scalars(select(PlanImage.id).where(PlanImage.created_by == user.id)))
    images_meta = [
        {"id": im.id, "plan_id": im.plan_id, "plan_name": plan_names.get(im.plan_id, "—"),
         "filename": im.filename, "byte_size": im.byte_size, "created_at": _iso(im.created_at)}
        for im in db.scalars(select(PlanImage).where(PlanImage.created_by == user.id).options(defer(PlanImage.data)))
    ]

    audit_log = [
        {"ts": _iso(a.ts), "action": a.action, "target_type": a.target_type, "target_id": a.target_id,
         "detail": a.detail or {}}
        for a in db.scalars(select(AuditLog).where(AuditLog.user_id == user.id))
    ]

    buf = tempfile.SpooledTemporaryFile(max_size=16 * 1024 * 1024)  # große Exporte landen auf Platte
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("profile.json", json.dumps(profile, ensure_ascii=False, indent=2))
        zf.writestr("favorites.json", json.dumps(favorites, ensure_ascii=False, indent=2))
        zf.writestr("plan_access.json", json.dumps(plan_access, ensure_ascii=False, indent=2))
        zf.writestr("plans_created.json", json.dumps(plans_created, ensure_ascii=False, indent=2))
        zf.writestr(
            "created_content.json",
            json.dumps(
                {
                    "markers": markers, "annotations": annotations, "strokes": strokes,
                    "plan_versions": plan_versions, "public_shares": public_shares,
                    "images": images_meta,
                },
                ensure_ascii=False, indent=2,
            ),
        )
        zf.writestr("audit_log.json", json.dumps(audit_log, ensure_ascii=False, indent=2))
        for image_id in images:  # Bilder einzeln laden und wieder freigeben
            im = db.get(PlanImage, image_id)
            if im is None:
                continue
            safe_name = im.filename or f"{im.id}.bin"
            zf.writestr(f"images/{im.id}_{safe_name}", im.data)
            db.expunge(im)

    buf.seek(0)
    audit.record(db, "user.export", user_id=user.id, target_type="user", target_id=user.id)
    db.commit()
    fname = f"sidc-daten-{user.username}.zip"
    def _iter():
        try:
            while chunk := buf.read(1024 * 1024):
                yield chunk
        finally:
            buf.close()

    return StreamingResponse(
        _iter(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.delete("/me")
def delete_my_account(request: Request, response: Response, user: CurrentUser, db: DbDep) -> dict:
    """Eigenes Konto und die daran hängenden persönlichen Daten löschen (Recht auf
    Löschung). Plan-Inhalte, die der Nutzer erstellt hat (Marker, Bilder, …), bleiben
    erhalten — wie beim Löschen durch einen Admin — verlieren aber die Zuordnung."""
    from .admin import is_protected_admin

    if is_protected_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Lokales Admin-Konto ist geschützt und nicht löschbar")
    if user.is_admin:
        others = db.scalar(
            select(User.id).where(User.role == "admin", User.is_active.is_(True), User.id != user.id)
        )
        if others is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Letzter aktiver Administrator — Konto kann nicht gelöscht werden.",
            )

    audit.record(db, "user.self_delete", user_id=user.id, target_type="user", target_id=user.id, request=request)
    db.query(PlanACL).filter(PlanACL.subject_type == "user", PlanACL.subject_id == user.id).delete()
    db.delete(user)
    db.commit()
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


def _me(db: DbDep, user: User) -> MeOut:
    from ..permissions import (
        effective_map_manager, effective_mission_builder, effective_technician, effective_zeus, is_local_admin, is_staff,
    )

    return MeOut(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        role=user.role,
        can_create_plans=user.can_create_plans,
        is_mission_builder=user.is_mission_builder,
        is_zeus=user.is_zeus,
        is_technician=user.is_technician,
        can_manage_maps=user.can_manage_maps,
        is_staff=is_staff(db, user),
        is_technician_effective=effective_technician(db, user),
        can_manage_maps_effective=effective_map_manager(db, user),
        can_grant_rights=is_local_admin(db, user),
        name_locked=name_locked(db, user),
        can_create_plans_effective=can_create_plans(db, user),
        is_mission_builder_effective=effective_mission_builder(db, user),
        is_zeus_effective=effective_zeus(db, user),
        ui_settings=user.ui_settings or {},
    )


# ─── OIDC ──────────────────────────────────────────────────────────────────

@router.get("/oidc/enabled")
def oidc_enabled() -> dict:
    """Was die Anmeldeseite wissen muss (ohne Login lesbar, keine Geheimnisse)."""
    info: dict = {"enabled": _OIDC_READY, "local_login": _settings.local_login}
    # AUTH-R-001: Name des Anmeldedienstes für Knopf und Hinweise; fehlt, wenn nicht eingestellt.
    provider_name = _settings.oidc_provider_label()
    if provider_name:
        info["provider_name"] = provider_name
    return info


class LinkStartIn(BaseModel):
    code: str = Field(min_length=1, max_length=128)


def _session_user_id(request: Request, db: DbDep) -> str | None:
    """ID des Kontos, für das dieser Browser eine gültige Sitzung im Tool hat (sonst None)."""
    token = request.cookies.get(SESSION_COOKIE)
    sess = read_session(token) if token else None
    user = db.get(User, sess[0]) if sess else None
    if user is None or not user.is_active or sess[1] != (user.session_epoch or 0):
        return None
    return user.id


def _link_problem(db: DbDep, row, target: User | None, session_uid: str | None, identity) -> str | None:
    """Warum sich dieser Code jetzt nicht einlösen lässt (None = geht). ``identity`` ist die
    schon bekannte Identität der Person beim Provider, falls es eine gibt."""
    if row is None or target is None:
        return "invalid_code"
    if oidc_access.is_bootstrap_admin(target):
        return "bootstrap_account"  # der Start-Admin bleibt der lokale Notfallzugang
    if oidc_access.has_identity(db, target.id):
        return "account_already_linked"
    if not target.is_active:
        return "account_inactive"
    # Besitznachweis: Der Code des Admins ist nur die Freigabe. Einlösen kann ihn nur, wer in
    # diesem Browser als das Zielkonto angemeldet ist; sonst bände ein weitergegebener Link
    # eine fremde Person (und ihre Gruppen) an das Konto.
    if session_uid != target.id:
        return "not_owner"
    if identity is not None:
        return "identity_in_use"
    return None


@router.post("/oidc/link")
def oidc_link_start(body: LinkStartIn, request: Request, db: DbDep) -> dict:
    """AUTH-R-014: Verknüpfungscode für den folgenden OIDC-Login vormerken. Der Code kommt im
    Rumpf (nicht in der Adresse, damit er in keinem Zugriffsprotokoll steht) und reist in der
    kurzlebigen Sitzung des Ablaufs mit. Eingelöst wird er erst im Rückruf, nach erneuter Prüfung.
    Die Antwort sagt der Link-Seite, zu welchem Konto der Code gehört und ob der Besitznachweis
    (lokale Sitzung dieses Kontos) vorliegt."""
    if not _OIDC_READY:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "OIDC ist nicht konfiguriert")
    request.session[_LINK_SESSION_KEY] = body.code
    row = oidc_access.find_link_code(db, body.code)
    target = db.get(User, row.user_id) if row is not None else None
    problem = _link_problem(db, row, target, _session_user_id(request, db), None)
    if problem not in (None, "not_owner"):
        return {"ok": True, "valid": False, "account": None, "owner_session": False}
    return {"ok": True, "valid": True, "account": target.label, "owner_session": problem is None}


@router.get("/oidc/login")
async def oidc_login(request: Request):
    if not _OIDC_READY:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "OIDC ist nicht konfiguriert")
    redirect_uri = _settings.oidc_redirect_url or str(request.url_for("oidc_callback"))
    return await _oauth.oidc.authorize_redirect(request, redirect_uri)


def _back_to_login(reason: str) -> RedirectResponse:
    """Zurück zur Anmeldeseite; sie zeigt den Grund zweisprachig an (kein Konto, keine Sitzung)."""
    return RedirectResponse(f"/?auth={reason}", status_code=status.HTTP_303_SEE_OTHER)


@router.get("/oidc/callback", name="oidc_callback")
async def oidc_callback(request: Request, response: Response, db: DbDep):
    if not _OIDC_READY:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "OIDC ist nicht konfiguriert")
    link_code = request.session.pop(_LINK_SESSION_KEY, None)
    session_uid = await run_in_threadpool(_session_user_id, request, db) if link_code else None
    try:
        # authlib prüft hier `state` gegen die Sitzung und `nonce` im ID-Token (AUTH-R-011).
        token = await _oauth.oidc.authorize_access_token(request)
    except (OAuthError, JoseError) as exc:
        log.warning("OIDC-Rückruf abgelehnt (%s)", type(exc).__name__)
        await run_in_threadpool(audit.record, db, "oidc.fail", request=request, reason=type(exc).__name__)
        return _back_to_login("failed")
    claims = token.get("userinfo") or {}
    issuer = claims.get("iss") or _settings.oidc_issuer
    subject = claims.get("sub")
    if not subject:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "OIDC-Token ohne 'sub'")
    if not isinstance(subject, str) or not isinstance(issuer, str):
        # Ein Provider, der `sub` nicht als Text liefert, hält sich nicht an OIDC: sauber ablehnen.
        await run_in_threadpool(audit.record, db, "oidc.fail", request=request, reason="invalid_sub")
        return _back_to_login("failed")

    result = await run_in_threadpool(
        _oidc_sign_in, db, request, claims, issuer, subject, link_code, session_uid
    )
    if isinstance(result, str):
        return _back_to_login(result)

    _set_session_cookie(request, response, result)
    # Nach dem Login zurück auf die App
    response.status_code = status.HTTP_303_SEE_OTHER
    response.headers["location"] = "/"
    return response


def _oidc_sign_in(
    db: DbDep, request: Request, claims: dict, issuer: str, subject: str, link_code: str | None,
    session_uid: str | None = None,
) -> User | str:
    """Person aus dem geprüften Token anmelden. Gibt den Nutzer zurück oder den Grund der
    Ablehnung (``denied``, ``link-failed``, ``link-login-first``) für die Anmeldeseite. Ins Audit-Protokoll kommen
    nur Vorgang und Grund, nie Token oder Claims (AUTH-R-013)."""
    groups = oidc_access.token_groups(claims)
    identity = db.scalar(
        select(OidcIdentity).where(
            OidcIdentity.issuer == issuer, OidcIdentity.subject == subject
        )
    )
    user = db.get(User, identity.user_id) if identity is not None else None

    # AUTH-R-003: ohne Zugangsgruppe kein Zugang und kein Konto.
    if not oidc_access.has_access(groups):
        if user is not None and user.is_active and not oidc_access.is_bootstrap_admin(user):
            # AUTH-R-009: bekanntes Konto deaktivieren; laufende Sitzungen enden damit sofort.
            user.is_active = False
            user.deactivated_by_sync = True
            user.session_epoch = (user.session_epoch or 0) + 1
            db.commit()
            audit.record(db, "oidc.deactivate", user_id=user.id, target_type="user", target_id=user.id,
                         request=request, reason="missing_group")
        audit.record(db, "oidc.denied", user_id=user.id if user is not None else None, request=request,
                     reason="missing_group", known=user is not None)
        return "denied"

    if link_code:
        # AUTH-R-014: Identität an das bestehende Konto hängen, für das der Admin den Code erzeugt
        # hat und als das die Person in diesem Browser angemeldet ist.
        row = oidc_access.find_link_code(db, link_code)
        target = db.get(User, row.user_id) if row is not None else None
        reason = _link_problem(db, row, target, session_uid, identity)
        if reason is None and not oidc_access.consume_link_code(db, row):
            db.rollback()
            reason = "invalid_code"  # gleichzeitig von einer anderen Anfrage eingelöst
        if reason:
            audit.record(db, "oidc.link_fail", target_type="user" if target is not None else None,
                         target_id=target.id if target is not None else None, request=request, reason=reason)
            return "link-login-first" if reason == "not_owner" else "link-failed"
        db.add(OidcIdentity(user_id=target.id, issuer=issuer, subject=subject))
        # Ab jetzt gibt es für dieses Konto nur noch den Weg über den Provider: alte Sitzungen
        # enden, das lokale Passwort entfällt, API-Tokens werden widerrufen.
        target.session_epoch = (target.session_epoch or 0) + 1
        target.password_hash = None
        for tok in db.scalars(select(ApiToken).where(ApiToken.user_id == target.id, ApiToken.revoked_at.is_(None))):
            tok.revoked_at = now()
        db.commit()
        audit.record(db, "oidc.link", user_id=target.id, target_type="user", target_id=target.id, request=request)
        user = target
    elif identity is None:
        username = _unique_username(db, oidc_access.username_base(claims, subject))
        user = User(username=username, role="user", can_create_plans=False)
        db.add(user)
        db.flush()
        db.add(OidcIdentity(user_id=user.id, issuer=issuer, subject=subject))
        from ..permissions import assign_default_group

        assign_default_group(db, user.id)
        db.commit()
        log.info("OIDC-User '%s' angelegt", username)
        audit.record(db, "oidc.user_create", user_id=user.id, target_type="user", target_id=user.id, request=request)

    if user is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Konto deaktiviert")
    if not user.is_active:
        if not user.deactivated_by_sync:  # vom Admin deaktiviert: bleibt es
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Konto deaktiviert")
        # AUTH-R-009: Der Abgleich hatte deaktiviert, die Zugangsgruppe ist wieder da.
        user.is_active = True
        user.deactivated_by_sync = False
        db.commit()
        audit.record(db, "oidc.reactivate", user_id=user.id, target_type="user", target_id=user.id, request=request)

    # AUTH-R-005: Anzeigename aus dem Token, wenn eingeschaltet.
    if _settings.oidc_sync_display_name:
        name = oidc_access.display_name_from(claims)
        if name and name != user.display_name:
            user.display_name = name
    # AUTH-R-007/-008/-010: angebundene Rechte genau nach den Gruppen setzen.
    changes = oidc_access.sync_rights(user, groups)
    db.commit()
    if changes:
        audit.record(db, "oidc.rights_sync", user_id=user.id, target_type="user", target_id=user.id,
                     request=request, changes=changes)
    return user


def name_locked(db, user: User) -> bool:
    """Anzeigename kommt aus OIDC → in C2 nicht änderbar."""
    return bool(
        _settings.oidc_sync_display_name
        and db.scalar(select(OidcIdentity.user_id).where(OidcIdentity.user_id == user.id))
    )


def _unique_username(db: DbDep, base: str) -> str:
    base = base.split("@")[0][:56] or "user"
    name = base
    i = 1
    # Der Name des Start-Admins (ohne Groß-/Kleinschreibung) wird nie vergeben, auch wenn es
    # das Konto noch nicht gibt: Sonst würde ein späterer Start es mit dem Start-Admin verwechseln.
    reserved = _settings.bootstrap_admin_user.lower()
    while name.lower() == reserved or db.scalar(select(User.id).where(User.username == name)):
        i += 1
        name = f"{base}-{i}"
    return name


__all__ = ["router", "hash_password"]
