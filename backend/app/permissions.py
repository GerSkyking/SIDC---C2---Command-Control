"""Effektive Plan-Rechte aus User- + Gruppen-ACL + globaler Adminrolle."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import GroupMember, Plan, PlanACL, User

LEVELS = ("viewer", "editor", "owner")
_RANK = {name: i for i, name in enumerate(LEVELS)}


def rank(level: str | None) -> int:
    return _RANK.get(level or "", -1)


def effective_level(db: Session, user: User, plan: Plan) -> str | None:
    """Höchstes Recht des Users auf den Plan, oder None wenn kein Zugriff."""
    if user.is_admin:
        return "owner"

    group_ids = list(db.scalars(select(GroupMember.group_id).where(GroupMember.user_id == user.id)))
    subjects = [("user", user.id)] + [("group", gid) for gid in group_ids]

    best: str | None = None
    rows = db.scalars(select(PlanACL).where(PlanACL.plan_id == plan.id))
    for acl in rows:
        if (acl.subject_type, acl.subject_id) in subjects and rank(acl.level) > rank(best):
            best = acl.level
    return best


CAP_KEYS = ("place", "move", "delete", "draw")


def effective_caps(db: Session, user: User, plan: Plan) -> dict[str, bool]:
    """Feingranulare Marker-/Zeichen-Rechte. owner/admin = alles, viewer = nichts,
    editor = OR über die passenden ACL-Einträge."""
    level = effective_level(db, user, plan)
    if level is None or rank(level) < rank("editor"):
        return dict.fromkeys(CAP_KEYS, False)
    if user.is_admin or rank(level) >= rank("owner"):
        return dict.fromkeys(CAP_KEYS, True)

    group_ids = list(db.scalars(select(GroupMember.group_id).where(GroupMember.user_id == user.id)))
    subjects = {("user", user.id), *(("group", gid) for gid in group_ids)}
    caps = dict.fromkeys(CAP_KEYS, False)
    for acl in db.scalars(select(PlanACL).where(PlanACL.plan_id == plan.id)):
        if (acl.subject_type, acl.subject_id) not in subjects or rank(acl.level) < rank("editor"):
            continue
        caps["place"] |= bool(acl.can_place)
        caps["move"] |= bool(acl.can_move)
        caps["delete"] |= bool(acl.can_delete)
        caps["draw"] |= bool(acl.can_draw)
    return caps


def can_create_plans(db: Session, user: User) -> bool:
    if user.is_admin or user.can_create_plans:
        return True
    group_flags = db.scalars(
        select(GroupMember.group_id).where(GroupMember.user_id == user.id)
    )
    from .models import Group

    gids = list(group_flags)
    if not gids:
        return False
    return bool(
        db.scalars(
            select(Group.id).where(Group.id.in_(gids), Group.can_create_plans.is_(True))
        ).first()
    )


def assign_default_group(db: Session, user_id: str) -> None:
    """Neuen Nutzer der konfigurierten Default-Gruppe zuordnen (falls gesetzt/vorhanden)."""
    from .config import get_settings
    from .models import Group, GroupMember

    name = (get_settings().default_user_group or "").strip()
    if not name:
        return
    g = db.scalar(select(Group).where(Group.name == name))
    if g is None:
        return
    exists = db.scalar(
        select(GroupMember.group_id).where(
            GroupMember.group_id == g.id, GroupMember.user_id == user_id
        )
    )
    if not exists:
        db.add(GroupMember(group_id=g.id, user_id=user_id))


def effective_mission_builder(db: Session, user: User) -> bool:
    """Globale Missionsbau-Rolle: User-Flag ODER eine Gruppen-Flag ODER Admin."""
    if user.is_admin or getattr(user, "is_mission_builder", False):
        return True
    from .models import Group

    gids = list(db.scalars(select(GroupMember.group_id).where(GroupMember.user_id == user.id)))
    if not gids:
        return False
    return bool(
        db.scalars(
            select(Group.id).where(Group.id.in_(gids), Group.is_mission_builder.is_(True))
        ).first()
    )
