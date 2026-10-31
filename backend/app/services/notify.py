"""Benachrichtigungen (System-Feed): wird von Aufgaben-Threads, Zuweisungen und dem Chat befüllt."""
from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy.orm import Session

from ..models import Notification, User


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
) -> int:
    """Legt je Empfänger eine Benachrichtigung an (ohne commit – läuft in der Transaktion der Aktion).
    Der Auslöser selbst wird nie benachrichtigt."""
    n = 0
    for uid in set(user_ids):
        if not uid or (actor is not None and uid == actor.id):
            continue
        db.add(Notification(
            user_id=uid, kind=kind, actor_id=actor.id if actor else None, title=title[:200], text=text[:300],
            project_id=project_id, task_id=task_id, conversation_id=conversation_id,
        ))
        n += 1
    return n
