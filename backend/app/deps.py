"""FastAPI-Dependencies: aktueller User, Adminzwang, Plan-Level-Prüfung."""
from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, Path, Request, status
from sqlalchemy.orm import Session

from .db import get_db
from .models import ApiToken, Plan, User
from .permissions import effective_level, rank
from .security import SESSION_COOKIE, read_session
from .tokens import resolve_token

DbDep = Annotated[Session, Depends(get_db)]


def get_current_user(request: Request, db: DbDep) -> User:
    token = request.cookies.get(SESSION_COOKIE)
    sess = read_session(token) if token else None
    user = db.get(User, sess[0]) if sess else None
    if user is None or not user.is_active or sess[1] != (user.session_epoch or 0):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Nicht angemeldet")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


class ClientAuth:
    """Ergebnis der Client-Authentifizierung: Nutzer + (bei Bearer) der verwendete Token."""

    def __init__(self, user: User, token: ApiToken | None):
        self.user = user
        self.token = token

    def has_scope(self, scope: str) -> bool:
        # Cookie-Session (eingeloggter Browser) hat volle Rechte des Nutzers.
        return self.token is None or scope in (self.token.scopes or [])


def get_client_auth(request: Request, db: DbDep) -> ClientAuth:
    """Für die Client-API (/api/client/*): ``Authorization: Bearer <token>`` ODER die
    normale Cookie-Session. Alle *anderen* Routen bleiben Cookie-only (``CurrentUser``) —
    ein API-Token kommt dort nie durch."""
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        found = resolve_token(db, header[7:].strip())
        if found is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Ungültiger oder abgelaufener Token")
        return ClientAuth(found[1], found[0])
    return ClientAuth(get_current_user(request, db), None)


def require_client_scope(scope: str):
    def _dep(auth: Annotated[ClientAuth, Depends(get_client_auth)]) -> ClientAuth:
        if not auth.has_scope(scope):
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Token-Scope '{scope}' fehlt")
        return auth

    return _dep


def require_admin(user: CurrentUser) -> User:
    if not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Adminrechte erforderlich")
    return user


AdminUser = Annotated[User, Depends(require_admin)]


def load_plan(plan_id: Annotated[str, Path()], db: DbDep) -> Plan:
    plan = db.get(Plan, plan_id)
    if plan is None or plan.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Plan nicht gefunden")
    return plan


def require_plan_level(min_level: str):
    def _dep(plan: Annotated[Plan, Depends(load_plan)], user: CurrentUser, db: DbDep) -> Plan:
        level = effective_level(db, user, plan)
        if rank(level) < rank(min_level):
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Recht '{min_level}' erforderlich")
        return plan

    return _dep
