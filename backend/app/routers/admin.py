"""Admin: Serviceaktionen, lokale User, Gruppen."""
from __future__ import annotations

import asyncio
import logging
import os
import signal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..deps import AdminUser, DbDep
from ..models import Group, GroupMember, User
from ..security import MIN_PASSWORD_LEN, hash_password

log = logging.getLogger("sidc.admin")
router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.post("/restart")
async def restart_backend(admin: AdminUser) -> dict:
    """Beendet den Backend-Prozess; Docker (`restart: unless-stopped`) startet den
    Container neu. db/redis laufen weiter. ~2 s Ausfall."""
    log.warning("Neustart durch Admin '%s' ausgelöst", admin.username)

    async def _bye() -> None:
        await asyncio.sleep(0.3)
        os.kill(os.getpid(), signal.SIGTERM)

    asyncio.create_task(_bye())
    return {"ok": True, "message": "Backend startet neu"}


# ─── Lokale User ───────────────────────────────────────────────────────────

class UserCreate(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str
    role: str = Field(default="user", pattern=r"^(admin|user)$")
    can_create_plans: bool = False


class UserPatch(BaseModel):
    role: str | None = Field(default=None, pattern=r"^(admin|user)$")
    can_create_plans: bool | None = None
    is_active: bool | None = None
    password: str | None = None


class UserRow(BaseModel):
    id: str
    username: str
    role: str
    can_create_plans: bool
    is_active: bool
    is_local: bool  # hat ein Passwort (kein reiner OIDC-User)


def _row(u: User) -> UserRow:
    return UserRow(
        id=u.id, username=u.username, role=u.role, can_create_plans=u.can_create_plans,
        is_active=u.is_active, is_local=bool(u.password_hash),
    )


@router.get("/users", response_model=list[UserRow])
def list_users(admin: AdminUser, db: DbDep) -> list[UserRow]:
    return [_row(u) for u in db.scalars(select(User).order_by(User.username))]


@router.post("/users", response_model=UserRow, status_code=status.HTTP_201_CREATED)
def create_user(body: UserCreate, admin: AdminUser, db: DbDep) -> UserRow:
    if len(body.password) < MIN_PASSWORD_LEN:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Passwort min. {MIN_PASSWORD_LEN} Zeichen")
    if db.scalar(select(User.id).where(User.username == body.username)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Benutzername vergeben")
    u = User(
        username=body.username, password_hash=hash_password(body.password),
        role=body.role, can_create_plans=body.can_create_plans,
    )
    db.add(u)
    db.commit()
    return _row(u)


@router.patch("/users/{user_id}", response_model=UserRow)
def patch_user(user_id: str, body: UserPatch, admin: AdminUser, db: DbDep) -> UserRow:
    u = db.get(User, user_id)
    if u is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    if body.password is not None:
        if len(body.password) < MIN_PASSWORD_LEN:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Passwort min. {MIN_PASSWORD_LEN} Zeichen")
        u.password_hash = hash_password(body.password)
    if body.role is not None:
        if u.id == admin.id and body.role != "admin":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Eigene Adminrolle nicht entziehbar")
        u.role = body.role
    if body.can_create_plans is not None:
        u.can_create_plans = body.can_create_plans
    if body.is_active is not None:
        if u.id == admin.id and not body.is_active:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Eigenes Konto nicht deaktivierbar")
        u.is_active = body.is_active
    db.commit()
    return _row(u)


@router.delete("/users/{user_id}")
def delete_user(user_id: str, admin: AdminUser, db: DbDep) -> dict:
    u = db.get(User, user_id)
    if u is None:
        return {"ok": True}
    if u.id == admin.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Eigenes Konto nicht löschbar")
    db.delete(u)
    db.commit()
    return {"ok": True}


# ─── Gruppen ───────────────────────────────────────────────────────────────

class GroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    can_create_plans: bool = False


class GroupRow(BaseModel):
    id: str
    name: str
    can_create_plans: bool
    member_ids: list[str]


def _grow(g: Group, member_ids: list[str]) -> GroupRow:
    return GroupRow(id=g.id, name=g.name, can_create_plans=g.can_create_plans, member_ids=member_ids)


@router.get("/groups", response_model=list[GroupRow])
def list_groups(admin: AdminUser, db: DbDep) -> list[GroupRow]:
    out = []
    for g in db.scalars(select(Group).order_by(Group.name)):
        mids = list(db.scalars(select(GroupMember.user_id).where(GroupMember.group_id == g.id)))
        out.append(_grow(g, mids))
    return out


@router.post("/groups", response_model=GroupRow, status_code=status.HTTP_201_CREATED)
def create_group(body: GroupIn, admin: AdminUser, db: DbDep) -> GroupRow:
    if db.scalar(select(Group.id).where(Group.name == body.name)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Gruppenname vergeben")
    g = Group(name=body.name, can_create_plans=body.can_create_plans)
    db.add(g)
    db.commit()
    return _grow(g, [])


@router.patch("/groups/{group_id}", response_model=GroupRow)
def patch_group(group_id: str, body: GroupIn, admin: AdminUser, db: DbDep) -> GroupRow:
    g = db.get(Group, group_id)
    if g is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    g.name = body.name
    g.can_create_plans = body.can_create_plans
    db.commit()
    mids = list(db.scalars(select(GroupMember.user_id).where(GroupMember.group_id == g.id)))
    return _grow(g, mids)


@router.put("/groups/{group_id}/members", response_model=GroupRow)
def set_members(group_id: str, user_ids: list[str], admin: AdminUser, db: DbDep) -> GroupRow:
    g = db.get(Group, group_id)
    if g is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    db.query(GroupMember).filter(GroupMember.group_id == group_id).delete()
    valid = set(db.scalars(select(User.id).where(User.id.in_(user_ids))))
    for uid in valid:
        db.add(GroupMember(group_id=group_id, user_id=uid))
    db.commit()
    return _grow(g, list(valid))


@router.delete("/groups/{group_id}")
def delete_group(group_id: str, admin: AdminUser, db: DbDep) -> dict:
    g = db.get(Group, group_id)
    if g is not None:
        db.delete(g)
        db.commit()
    return {"ok": True}
