"""Effektive Rechte: Plan-ACL (User + Gruppen + Systemgruppe "public"), globale Flags, Projekt-Missionsbau.

Rollenmodell (Admin ist reine Verwaltung, kein Missionsbau/Zeus):
- admin        Nutzer anlegen/deaktivieren, Log, Discord-Brücke; sieht/verwaltet die normalen (nicht projektbezogenen) Pläne
- technician   Speicher + Einstellungen, Nutzer/Rechte nur lesen, Gruppen anlegen; Pläne wie Admin
- mission_builder / zeus / can_create_plans / can_manage_maps: eigene Flags am Nutzer oder an einer Gruppe
- Projektbezogene Pläne und Projekte sehen nur Mitglieder (bzw. wer per ACL/„public“ Zugriff bekam) — auch Admins nicht.
- Rechte vergeben darf nur ein lokaler Admin (``is_local_admin``); Rechte aus Gruppen/Projekten lassen sich nicht weitergeben.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Group, GroupMember, OidcIdentity, Plan, PlanACL, ProjectMember, User

LEVELS = ("viewer", "editor", "owner")
_RANK = {name: i for i, name in enumerate(LEVELS)}


def rank(level: str | None) -> int:
    return _RANK.get(level or "", -1)


def subjects_of(db: Session, user: User) -> list[tuple[str, str]]:
    """Alle Träger, über die ein Nutzer Rechte erben kann: er selbst, seine Gruppen und die
    Systemgruppe „public“ (jeder Nutzer gehört implizit dazu)."""
    out = [("user", user.id)]
    out += [("group", gid) for gid in db.scalars(select(GroupMember.group_id).where(GroupMember.user_id == user.id))]
    for gid in db.scalars(select(Group.id).where(Group.is_system.is_(True))):
        if ("group", gid) not in out:
            out.append(("group", gid))
    return out


def _flag(db: Session, user: User, name: str) -> bool:
    """Flag am Nutzer ODER an einer seiner Gruppen."""
    if getattr(user, name, False):
        return True
    gids = list(db.scalars(select(GroupMember.group_id).where(GroupMember.user_id == user.id)))
    if not gids:
        return False
    col = getattr(Group, name)
    return bool(db.scalars(select(Group.id).where(Group.id.in_(gids), col.is_(True))).first())


def effective_technician(db: Session, user: User) -> bool:
    return _flag(db, user, "is_technician")


def is_staff(db: Session, user: User) -> bool:
    """Admin oder Techniker: Verwaltungszugriff (Speicher, Einstellungen, Nutzerliste, normale Pläne)."""
    return user.is_admin or effective_technician(db, user)


def effective_map_manager(db: Session, user: User) -> bool:
    return is_staff(db, user) or _flag(db, user, "can_manage_maps")


def is_local_admin(db: Session, user: User) -> bool:
    """Admin mit lokalem Konto (ohne OIDC-Identität): nur er vergibt Rechte. Bei OIDC kommen Rechte
    aus der Anmeldung."""
    return user.is_admin and db.scalar(select(OidcIdentity.id).where(OidcIdentity.user_id == user.id)) is None


def project_role(db: Session, user: User, project_id: str | None) -> str | None:
    """Rolle des Users in einem Projekt (viewer < editor < owner). Admins haben hier KEINE Sonderrechte."""
    if not project_id:
        return None
    subjects = subjects_of(db, user)
    best: str | None = None
    for m in db.scalars(select(ProjectMember).where(ProjectMember.project_id == project_id)):
        if (m.subject_type, m.subject_id) in subjects and rank(m.role) > rank(best):
            best = m.role
    return best


def project_builder(db: Session, user: User, project_id: str | None) -> bool:
    """Missionsbau-Recht aus der Projektmitgliedschaft (nur in diesem Projekt)."""
    if not project_id:
        return False
    subjects = subjects_of(db, user)
    return any(
        (m.subject_type, m.subject_id) in subjects
        for m in db.scalars(select(ProjectMember).where(ProjectMember.project_id == project_id, ProjectMember.is_builder.is_(True)))
    )


def effective_level(db: Session, user: User, plan: Plan) -> str | None:
    """Höchstes Recht des Users auf den Plan, oder None wenn kein Zugriff.
    Allein die Plan-ACL zählt (inkl. Gruppe „public“); die Projektrolle hat KEINEN Einfluss auf Plan-Rechte.
    Admin/Techniker verwalten die normalen Pläne; projektbezogene Pläne nur über ACL."""
    if plan.project_id is None and is_staff(db, user):
        return "owner"

    subjects = subjects_of(db, user)

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
    if rank(level) >= rank("owner"):
        return dict.fromkeys(CAP_KEYS, True)

    subjects = set(subjects_of(db, user))
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
    return is_staff(db, user) or _flag(db, user, "can_create_plans")


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


def effective_mission_builder(db: Session, user: User, project_id: str | None = None) -> bool:
    """Globale Missionsbau-Rolle: User-Flag ODER Gruppen-Flag. Die Adminrolle schließt sie NICHT ein.
    Mit ``project_id`` zählt zusätzlich ein Projekt-Missionsbauer (nur für dieses Projekt/seine Pläne)."""
    return _flag(db, user, "is_mission_builder") or project_builder(db, user, project_id)


def effective_zeus(db: Session, user: User) -> bool:
    """Zeus-Rolle: User-Flag ODER Gruppen-Flag (Admins/Missionsbauer haben sie nicht automatisch)."""
    return _flag(db, user, "is_zeus")
