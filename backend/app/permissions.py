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
