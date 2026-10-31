"""Benachrichtigungen (System-Feed): wird von Aufgaben-Threads, Zuweisungen und dem Chat befüllt."""
from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import GroupMember, Notification, User


def send(
    db: Session,
    user_ids: Iterable[str],
    kind: str,
    *,
    actor: User | None,
    title: str = "",
    text: str = "",
    project_id: str | None = None,
    task_id: str | None = None,
    conversation_id: str | None = None,
    plan_id: str | None = None,
) -> int:
    """Legt je Empfänger eine Benachrichtigung an (ohne commit – läuft in der Transaktion der Aktion).
    Der Auslöser selbst wird nie benachrichtigt."""
    n = 0
    for uid in set(user_ids):
        if not uid or (actor is not None and uid == actor.id):
            continue
        db.add(Notification(
            user_id=uid, kind=kind, actor_id=actor.id if actor else None, title=title[:200], text=text[:300],
            project_id=project_id, task_id=task_id, conversation_id=conversation_id, plan_id=plan_id,
        ))
        n += 1
    return n


def subject_user_ids(db: Session, subjects: Iterable[tuple[str, str]]) -> set[str]:
    """Aktive Nutzer hinter Einträgen ("user"/"group", id) – Gruppen werden zu ihren Mitgliedern aufgelöst."""
    users: set[str] = set()
    groups: list[str] = []
    for typ, sid in subjects:
        (users.add(sid) if typ == "user" else groups.append(sid))
    if groups:
        users.update(db.scalars(select(GroupMember.user_id).where(GroupMember.group_id.in_(groups))))
    if not users:
        return set()
    return set(db.scalars(select(User.id).where(User.id.in_(users), User.is_active.is_(True))))
