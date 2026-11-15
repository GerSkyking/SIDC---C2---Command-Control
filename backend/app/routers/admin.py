"""Admin: Serviceaktionen, lokale User, Gruppen."""
from __future__ import annotations

import asyncio
import logging
import os
import signal

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy import desc, func, select

from .. import audit
from ..deps import AdminUser, DbDep, StaffUser
from ..permissions import is_local_admin
from ..config import get_settings
from ..models import ApiToken, AuditLog, Group, GroupMember, Map, Plan, PlanImage, Project, ProjectDoc, User
from ..models import now as _now
from ..security import MIN_PASSWORD_LEN, hash_password
from ..services.maps_import import dir_bytes
from ..services.realtime import broadcast_from_thread

log = logging.getLogger("sidc.admin")
router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.post("/restart")
async def restart_backend(request: Request, admin: StaffUser, db: DbDep) -> dict:
    """Beendet den Backend-Prozess; Docker (`restart: unless-stopped`) startet den
    Container neu. db/redis laufen weiter. ~2 s Ausfall."""
    log.warning("Neustart durch Admin '%s' ausgelöst", admin.username)
    await run_in_threadpool(audit.record, db, "backend.restart", user_id=admin.id, request=request)

    async def _bye() -> None:
        await asyncio.sleep(0.3)
        os.kill(os.getpid(), signal.SIGTERM)

    asyncio.create_task(_bye())
    return {"ok": True, "message": "Backend startet neu"}


# ─── Lokale User ───────────────────────────────────────────────────────────

class UserCreate(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(max_length=256)
    display_name: str = Field(default="", max_length=64)
    role: str = Field(default="user", pattern=r"^(admin|user)$")
    can_create_plans: bool = False
    is_mission_builder: bool = False
    is_zeus: bool = False
    is_technician: bool = False
    can_manage_maps: bool = False


class UserPatch(BaseModel):
    role: str | None = Field(default=None, pattern=r"^(admin|user)$")
    can_create_plans: bool | None = None
    is_mission_builder: bool | None = None
    is_zeus: bool | None = None
    is_technician: bool | None = None
    can_manage_maps: bool | None = None
    is_active: bool | None = None
    password: str | None = Field(default=None, max_length=256)
    display_name: str | None = Field(default=None, max_length=64)


class UserRow(BaseModel):
    id: str
    username: str
    display_name: str = ""
    role: str
    can_create_plans: bool
    is_mission_builder: bool = False
    is_zeus: bool = False
    is_technician: bool = False
    can_manage_maps: bool = False
    is_active: bool
    is_local: bool  # hat ein Passwort (kein reiner OIDC-User)
    protected: bool = False  # lokaler Bootstrap-Admin: nicht löschbar, Rechte/Passwort nur über die Server-Konfiguration


def is_protected_admin(u: User) -> bool:
    """Das lokale Bootstrap-Admin-Konto (BOOTSTRAP_ADMIN_USER). Es wird nur über die Server-Konfiguration
    verwaltet — nicht löschbar, Rechte/Aktivstatus/Passwort per Web-UI/API unveränderlich."""
    return bool(u.password_hash) and u.username == get_settings().bootstrap_admin_user


# Rechte-Felder: nur lokale Admins dürfen sie vergeben (OIDC-Admins/Techniker nie).
RIGHT_FIELDS = ("role", "can_create_plans", "is_mission_builder", "is_zeus", "is_technician", "can_manage_maps")
_RIGHTS_MSG = "Rechte und Rollen darf nur ein lokaler Admin vergeben"


def _require_local_admin(db, actor: User) -> None:
    if not is_local_admin(db, actor):
        raise HTTPException(status.HTTP_403_FORBIDDEN, _RIGHTS_MSG)


_PROTECTED_MSG = "Lokales Admin-Konto ist geschützt (Verwaltung nur über die Server-Konfiguration)"


def _row(u: User) -> UserRow:
    return UserRow(
        id=u.id, username=u.username, display_name=u.display_name, role=u.role,
        can_create_plans=u.can_create_plans, is_mission_builder=u.is_mission_builder,
        is_zeus=u.is_zeus, is_technician=u.is_technician, can_manage_maps=u.can_manage_maps,
        is_active=u.is_active, is_local=bool(u.password_hash),
        protected=is_protected_admin(u),
    )


@router.get("/users", response_model=list[UserRow])
def list_users(admin: StaffUser, db: DbDep) -> list[UserRow]:
    return [_row(u) for u in db.scalars(select(User).order_by(User.username))]


@router.post("/users", response_model=UserRow, status_code=status.HTTP_201_CREATED)
def create_user(body: UserCreate, request: Request, admin: AdminUser, db: DbDep) -> UserRow:
    if len(body.password) < MIN_PASSWORD_LEN:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Passwort min. {MIN_PASSWORD_LEN} Zeichen")
    if body.role != "user" or any(getattr(body, f) for f in RIGHT_FIELDS if f != "role"):
        _require_local_admin(db, admin)
    if db.scalar(select(User.id).where(User.username == body.username)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Benutzername vergeben")
    u = User(
        username=body.username, password_hash=hash_password(body.password),
        display_name=body.display_name.strip()[:64],
        role=body.role, can_create_plans=body.can_create_plans,
        is_mission_builder=body.is_mission_builder, is_zeus=body.is_zeus,
        is_technician=body.is_technician, can_manage_maps=body.can_manage_maps,
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
    if any(getattr(body, f, None) is not None for f in RIGHT_FIELDS):
        _require_local_admin(db, admin)
    if is_protected_admin(u) and any(
        getattr(body, f, None) is not None
        for f in ("password", "is_active", *RIGHT_FIELDS)
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, _PROTECTED_MSG)
    if body.password is not None:
        if len(body.password) < MIN_PASSWORD_LEN:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Passwort min. {MIN_PASSWORD_LEN} Zeichen")
        u.password_hash = hash_password(body.password)
        u.session_epoch = (u.session_epoch or 0) + 1  # bestehende Sessions ungültig machen
        for tok in db.scalars(select(ApiToken).where(ApiToken.user_id == u.id, ApiToken.revoked_at.is_(None))):
            tok.revoked_at = _now()  # API-Tokens überleben keinen Passwort-Reset
    if body.role is not None:
        if u.id == admin.id and body.role != "admin":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Eigene Adminrolle nicht entziehbar")
        u.role = body.role
    if body.can_create_plans is not None:
        u.can_create_plans = body.can_create_plans
    if body.is_mission_builder is not None:
        u.is_mission_builder = body.is_mission_builder
    if body.is_zeus is not None:
        u.is_zeus = body.is_zeus
    if body.is_technician is not None:
        u.is_technician = body.is_technician
    if body.can_manage_maps is not None:
        u.can_manage_maps = body.can_manage_maps
    if body.display_name is not None:
        from .auth import name_locked

        if name_locked(db, u):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Anzeigename kommt aus dem Identity-Provider")
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
    if is_protected_admin(u):
        raise HTTPException(status.HTTP_403_FORBIDDEN, _PROTECTED_MSG)
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
        if uid is None:
            return {"items": [], "offset": 0, "limit": max(1, min(limit, 500))}
        q = q.where(AuditLog.user_id == uid)
    limit = max(1, min(limit, 500))
    offset = max(0, offset)
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


# ─── Speicherauswertung pro Projekt ────────────────────────────────────────

@router.get("/projects/storage")
def projects_storage(admin: StaffUser, db: DbDep) -> list[dict]:
    img = dict(db.execute(
        select(PlanImage.project_id, func.coalesce(func.sum(PlanImage.byte_size), 0))
        .where(PlanImage.project_id.is_not(None)).group_by(PlanImage.project_id)
    ).all())
    docs = dict(db.execute(
        select(ProjectDoc.project_id, func.coalesce(func.sum(ProjectDoc.byte_size), 0))
        .group_by(ProjectDoc.project_id)
    ).all())
    plans = dict(db.execute(
        select(Plan.project_id, func.count(Plan.id))
        .where(Plan.project_id.is_not(None), Plan.deleted_at.is_(None)).group_by(Plan.project_id)
    ).all())
    out = []
    for p in db.scalars(select(Project)):
        ib, dbytes = int(img.get(p.id, 0)), int(docs.get(p.id, 0))
        out.append({
            "project_id": p.id, "name": p.name, "images_bytes": ib, "docs_bytes": dbytes,
            "plans_count": int(plans.get(p.id, 0)), "total_bytes": ib + dbytes,
        })
    out.sort(key=lambda r: r["total_bytes"], reverse=True)
    return out


@router.get("/maps/storage")
async def maps_storage(admin: StaffUser, db: DbDep) -> list[dict]:
    """Plattenverbrauch je Karte, größte zuerst. Die Größe wird beim Import in ``Map.meta['bytes']``
    festgehalten; für ältere Karten wird sie einmalig nachgemessen und gespeichert."""
    base = get_settings().maps_dir
    maps = list(db.scalars(select(Map)))
    missing = [(m.id) for m in maps if not isinstance((m.meta or {}).get("bytes"), int)]
    if missing:
        sizes = await run_in_threadpool(lambda: {mid: dir_bytes(base / mid) for mid in missing})
        for m in maps:
            if m.id in sizes:
                m.meta = {**(m.meta or {}), "bytes": sizes[m.id]}
        db.commit()
    out = [{"map_id": m.id, "name": m.name, "status": m.status, "bytes": int((m.meta or {}).get("bytes") or 0)} for m in maps]
    out.sort(key=lambda r: r["bytes"], reverse=True)
    return out


# ─── Gruppen ───────────────────────────────────────────────────────────────

class GroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    can_create_plans: bool = False
    is_mission_builder: bool = False
    is_zeus: bool = False
    is_technician: bool = False
    can_manage_maps: bool = False


class GroupRow(BaseModel):
    id: str
    name: str
    can_create_plans: bool
    is_mission_builder: bool = False
    is_zeus: bool = False
    is_technician: bool = False
    can_manage_maps: bool = False
    is_system: bool = False
    member_ids: list[str]


GROUP_RIGHTS = ("can_create_plans", "is_mission_builder", "is_zeus", "is_technician", "can_manage_maps")


def _grow(g: Group, member_ids: list[str]) -> GroupRow:
    return GroupRow(
        id=g.id, name=g.name, can_create_plans=g.can_create_plans, is_mission_builder=g.is_mission_builder,
        is_zeus=g.is_zeus, is_technician=g.is_technician, can_manage_maps=g.can_manage_maps,
        is_system=g.is_system, member_ids=member_ids,
    )


def _has_rights(g: Group) -> bool:
    return any(getattr(g, f) for f in GROUP_RIGHTS)


def _no_system(g: Group) -> None:
    if g.is_system:
        raise HTTPException(status.HTTP_409_CONFLICT, "Systemgruppe ist nicht änderbar")


def _guard_members(db, actor: User, g: Group) -> None:
    """Mitglieder von Gruppen mit Rechten ändern nur lokale Admins (sonst Selbst-Eskalation); rechtelose Gruppen: Staff."""
    if _has_rights(g):
        _require_local_admin(db, actor)


@router.get("/groups", response_model=list[GroupRow])
def list_groups(admin: StaffUser, db: DbDep) -> list[GroupRow]:
    out = []
    for g in db.scalars(select(Group).order_by(Group.name)):
        mids = list(db.scalars(select(GroupMember.user_id).where(GroupMember.group_id == g.id)))
        out.append(_grow(g, mids))
    return out


@router.post("/groups", response_model=GroupRow, status_code=status.HTTP_201_CREATED)
def create_group(body: GroupIn, request: Request, admin: StaffUser, db: DbDep) -> GroupRow:
    if any(getattr(body, f) for f in GROUP_RIGHTS):
        _require_local_admin(db, admin)
    if db.scalar(select(Group.id).where(Group.name == body.name)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Gruppenname vergeben")
    g = Group(name=body.name, can_create_plans=body.can_create_plans, is_mission_builder=body.is_mission_builder,
              is_zeus=body.is_zeus,
              is_technician=body.is_technician, can_manage_maps=body.can_manage_maps)
    db.add(g)
    db.commit()
    audit.record(db, "group.create", user_id=admin.id, target_type="group", target_id=g.id,
                 request=request, name=g.name)
    return _grow(g, [])


@router.patch("/groups/{group_id}", response_model=GroupRow)
def patch_group(group_id: str, body: GroupIn, admin: StaffUser, db: DbDep) -> GroupRow:
    g = db.get(Group, group_id)
    if g is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    _no_system(g)
    if any(getattr(body, f) != getattr(g, f) for f in GROUP_RIGHTS):
        # Gruppenrechte: nur lokaler Admin, der selbst Mitglied der Gruppe ist
        _require_local_admin(db, admin)
        if not db.scalar(select(GroupMember.user_id).where(GroupMember.group_id == g.id, GroupMember.user_id == admin.id)):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Gruppenrechte setzt nur ein Mitglied der Gruppe")
    if db.scalar(select(Group.id).where(Group.name == body.name, Group.id != group_id)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Gruppenname vergeben")
    g.name = body.name
    g.can_create_plans = body.can_create_plans
    g.is_mission_builder = body.is_mission_builder
    g.is_zeus = body.is_zeus
    g.is_technician = body.is_technician
    g.can_manage_maps = body.can_manage_maps
    db.commit()
    mids = list(db.scalars(select(GroupMember.user_id).where(GroupMember.group_id == g.id)))
    return _grow(g, mids)


@router.put("/groups/{group_id}/members", response_model=GroupRow)
def set_members(group_id: str, user_ids: list[str], admin: StaffUser, db: DbDep) -> GroupRow:
    g = db.get(Group, group_id)
    if g is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    _no_system(g)
    _guard_members(db, admin, g)
    db.query(GroupMember).filter(GroupMember.group_id == group_id).delete()
    valid = set(db.scalars(select(User.id).where(User.id.in_(user_ids))))
    for uid in valid:
        db.add(GroupMember(group_id=group_id, user_id=uid))
    db.commit()
    return _grow(g, list(valid))


@router.delete("/groups/{group_id}")
def delete_group(group_id: str, admin: StaffUser, db: DbDep) -> dict:
    g = db.get(Group, group_id)
    if g is not None:
        _no_system(g)
        _guard_members(db, admin, g)
        db.delete(g)
        db.commit()
    return {"ok": True}
