"""Admin: Serviceaktionen, lokale User, Gruppen."""
from __future__ import annotations

import asyncio
import logging
import os
import signal

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import desc, select

from .. import audit
from ..deps import AdminUser, DbDep
from ..models import AuditLog, Group, GroupMember, Phase, Plan, PlanImage, User
from ..security import MIN_PASSWORD_LEN, hash_password
from ..services.realtime import hub

log = logging.getLogger("sidc.admin")
router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.post("/restart")
async def restart_backend(request: Request, admin: AdminUser, db: DbDep) -> dict:
    """Beendet den Backend-Prozess; Docker (`restart: unless-stopped`) startet den
    Container neu. db/redis laufen weiter. ~2 s Ausfall."""
    log.warning("Neustart durch Admin '%s' ausgelöst", admin.username)
    audit.record(db, "backend.restart", user_id=admin.id, request=request)

    async def _bye() -> None:
        await asyncio.sleep(0.3)
        os.kill(os.getpid(), signal.SIGTERM)

    asyncio.create_task(_bye())
    return {"ok": True, "message": "Backend startet neu"}


# ─── Lokale User ───────────────────────────────────────────────────────────

class UserCreate(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str
    display_name: str = Field(default="", max_length=64)
    role: str = Field(default="user", pattern=r"^(admin|user)$")
    can_create_plans: bool = False
    is_mission_builder: bool = False


class UserPatch(BaseModel):
    role: str | None = Field(default=None, pattern=r"^(admin|user)$")
    can_create_plans: bool | None = None
    is_mission_builder: bool | None = None
    is_active: bool | None = None
    password: str | None = None
    display_name: str | None = None


class UserRow(BaseModel):
    id: str
    username: str
    display_name: str = ""
    role: str
    can_create_plans: bool
    is_mission_builder: bool = False
    is_active: bool
    is_local: bool  # hat ein Passwort (kein reiner OIDC-User)


def _row(u: User) -> UserRow:
    return UserRow(
        id=u.id, username=u.username, display_name=u.display_name, role=u.role,
        can_create_plans=u.can_create_plans, is_mission_builder=u.is_mission_builder,
        is_active=u.is_active, is_local=bool(u.password_hash),
    )


@router.get("/users", response_model=list[UserRow])
def list_users(admin: AdminUser, db: DbDep) -> list[UserRow]:
    return [_row(u) for u in db.scalars(select(User).order_by(User.username))]


@router.post("/users", response_model=UserRow, status_code=status.HTTP_201_CREATED)
def create_user(body: UserCreate, request: Request, admin: AdminUser, db: DbDep) -> UserRow:
    if len(body.password) < MIN_PASSWORD_LEN:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Passwort min. {MIN_PASSWORD_LEN} Zeichen")
    if db.scalar(select(User.id).where(User.username == body.username)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Benutzername vergeben")
    u = User(
        username=body.username, password_hash=hash_password(body.password),
        display_name=body.display_name.strip()[:64],
        role=body.role, can_create_plans=body.can_create_plans,
        is_mission_builder=body.is_mission_builder,
    )
    db.add(u)
    db.flush()
    from ..permissions import assign_default_group

    assign_default_group(db, u.id)
    db.commit()
    audit.record(db, "user.create", user_id=admin.id, target_type="user", target_id=u.id,
                 request=request, username=u.username, role=u.role)
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
        u.session_epoch = (u.session_epoch or 0) + 1  # bestehende Sessions ungültig machen
    if body.role is not None:
        if u.id == admin.id and body.role != "admin":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Eigene Adminrolle nicht entziehbar")
        u.role = body.role
    if body.can_create_plans is not None:
        u.can_create_plans = body.can_create_plans
    if body.is_mission_builder is not None:
        u.is_mission_builder = body.is_mission_builder
    if body.display_name is not None:
        u.display_name = "".join(c for c in body.display_name.strip() if c.isprintable())[:64]
    if body.is_active is not None:
        if u.id == admin.id and not body.is_active:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Eigenes Konto nicht deaktivierbar")
        u.is_active = body.is_active
    db.commit()
    return _row(u)


@router.delete("/users/{user_id}")
def delete_user(user_id: str, request: Request, admin: AdminUser, db: DbDep) -> dict:
    u = db.get(User, user_id)
    if u is None:
        return {"ok": True}
    if u.id == admin.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Eigenes Konto nicht löschbar")
    uname = u.username
    db.delete(u)
    db.commit()
    audit.record(db, "user.delete", user_id=admin.id, target_type="user", target_id=user_id,
                 request=request, username=uname)
    return {"ok": True}


@router.get("/audit")
def list_audit(
    admin: AdminUser, db: DbDep, limit: int = 100, offset: int = 0,
    action: str | None = None, user: str | None = None,
) -> dict:
    q = select(AuditLog).order_by(desc(AuditLog.ts))
    if action:
        esc = action.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        q = q.where(AuditLog.action.like(f"{esc}%", escape="\\"))
    if user:
        uid = db.scalar(select(User.id).where(User.username == user))
        q = q.where(AuditLog.user_id == uid)
    limit = max(1, min(limit, 500))
    rows = list(db.scalars(q.limit(limit).offset(offset)))
    names = {
        u.id: u.username
        for u in db.scalars(select(User).where(User.id.in_([r.user_id for r in rows if r.user_id])))
    }
    return {
        "items": [
            {
                "ts": r.ts.isoformat(),
                "user": names.get(r.user_id) or (r.detail or {}).get("username") or "—",
                "action": r.action,
                "target": f"{r.target_type or ''}:{r.target_id or ''}".strip(":"),
                "detail": r.detail or {},
            }
            for r in rows
        ],
        "offset": offset,
        "limit": limit,
    }


# ─── Plan-Bilder (globale Übersicht) ───────────────────────────────────────

@router.get("/images")
def list_images(admin: AdminUser, db: DbDep) -> list[dict]:
    rows = list(db.scalars(select(PlanImage).order_by(desc(PlanImage.created_at)).limit(1000)))
    plan_names = {
        p.id: p.name for p in db.scalars(select(Plan).where(Plan.id.in_({r.plan_id for r in rows})))
    }
    phase_names = {
        p.id: p.name for p in db.scalars(select(Phase).where(Phase.id.in_({r.phase_id for r in rows if r.phase_id})))
    }
    users = {
        u.id: u.label
        for u in db.scalars(select(User).where(User.id.in_({r.created_by for r in rows if r.created_by})))
    }
    return [
        {
            "id": r.id, "filename": r.filename, "byte_size": r.byte_size,
            "content_type": r.content_type,
            "plan_id": r.plan_id, "plan_name": plan_names.get(r.plan_id, "—"),
            "phase_id": r.phase_id, "phase_name": phase_names.get(r.phase_id or "", "—"),
            "uploader": users.get(r.created_by or "", "—"),
            "created_at": r.created_at.isoformat(),
        }
        for r in rows
    ]


@router.delete("/images/{image_id}")
async def delete_image(image_id: str, request: Request, admin: AdminUser, db: DbDep) -> dict:
    img = db.get(PlanImage, image_id)
    if img is not None:
        plan_id = img.plan_id
        db.delete(img)
        db.commit()
        audit.record(db, "image.delete", user_id=admin.id, target_type="image",
                     target_id=image_id, request=request)
        await hub.broadcast(plan_id, {"type": "image.delete", "id": image_id})
    return {"ok": True}


# ─── Gruppen ───────────────────────────────────────────────────────────────

class GroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    can_create_plans: bool = False
    is_mission_builder: bool = False


class GroupRow(BaseModel):
    id: str
    name: str
    can_create_plans: bool
    is_mission_builder: bool = False
    member_ids: list[str]


def _grow(g: Group, member_ids: list[str]) -> GroupRow:
    return GroupRow(id=g.id, name=g.name, can_create_plans=g.can_create_plans, is_mission_builder=g.is_mission_builder, member_ids=member_ids)


@router.get("/groups", response_model=list[GroupRow])
def list_groups(admin: AdminUser, db: DbDep) -> list[GroupRow]:
    out = []
    for g in db.scalars(select(Group).order_by(Group.name)):
        mids = list(db.scalars(select(GroupMember.user_id).where(GroupMember.group_id == g.id)))
        out.append(_grow(g, mids))
    return out


@router.post("/groups", response_model=GroupRow, status_code=status.HTTP_201_CREATED)
def create_group(body: GroupIn, request: Request, admin: AdminUser, db: DbDep) -> GroupRow:
    if db.scalar(select(Group.id).where(Group.name == body.name)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Gruppenname vergeben")
    g = Group(name=body.name, can_create_plans=body.can_create_plans, is_mission_builder=body.is_mission_builder)
    db.add(g)
    db.commit()
    audit.record(db, "group.create", user_id=admin.id, target_type="group", target_id=g.id,
                 request=request, name=g.name)
    return _grow(g, [])


@router.patch("/groups/{group_id}", response_model=GroupRow)
def patch_group(group_id: str, body: GroupIn, admin: AdminUser, db: DbDep) -> GroupRow:
    g = db.get(Group, group_id)
    if g is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    g.name = body.name
    g.can_create_plans = body.can_create_plans
    g.is_mission_builder = body.is_mission_builder
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
