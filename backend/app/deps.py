"""FastAPI-Dependencies: aktueller User, Adminzwang, Plan-Level-Prüfung."""
from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, Path, Request, status
from sqlalchemy.orm import Session

from .db import get_db
from .models import Plan, User
from .permissions import effective_level, rank
from .security import SESSION_COOKIE, read_session

DbDep = Annotated[Session, Depends(get_db)]


def get_current_user(request: Request, db: DbDep) -> User:
    token = request.cookies.get(SESSION_COOKIE)
    uid = read_session(token) if token else None
    user = db.get(User, uid) if uid else None
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Nicht angemeldet")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


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
