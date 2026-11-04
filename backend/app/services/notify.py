"""Benachrichtigungen (System-Feed): wird von Aufgaben-Threads, Zuweisungen und dem Chat befüllt."""
from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import GroupMember, Notification, NotificationChannel, User

# Opt-in-Arten: standardmäßig AUS. `kinds=[]` eines Kanals steht nur für die Standard-Arten; diese Arten
# kommen nur an, wenn ein aktiver Kanal des Empfängers sie ausdrücklich in `kinds` hat.
OPT_IN_KINDS = frozenset({"feedback_new", "doc_mention"})
_MAX_OPT_IN_RECIPIENTS = 20


def kind_wanted(kinds: list | None, kind: str) -> bool:
    """Ob ein Kanal mit diesen `kinds` die Art zugestellt bekommt (leer = alle Standard-Arten)."""
    if kinds:
        return kind in kinds
    return kind not in OPT_IN_KINDS


def opt_in_recipients(db: Session, user_ids: Iterable[str], kind: str) -> set[str]:
    """Empfänger, die einen aktiven Kanal mit ausdrücklichem Abo auf `kind` haben (höchstens _MAX_OPT_IN_RECIPIENTS)."""
    ids = {u for u in user_ids if u}
    if not ids:
        return set()
    rows = db.execute(select(NotificationChannel.user_id, NotificationChannel.kinds).where(
        NotificationChannel.user_id.in_(ids), NotificationChannel.enabled.is_(True)))
    ok = sorted({uid for uid, kinds in rows if kinds and kind in kinds})
    return set(ok[:_MAX_OPT_IN_RECIPIENTS])


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
    Der Auslöser selbst wird nie benachrichtigt. Opt-in-Arten gehen nur an Empfänger mit ausdrücklichem Kanal-Abo
    (sonst weder Posteingang noch Zustellung)."""
    n = 0
    uids = set(user_ids)
    if kind in OPT_IN_KINDS:
        uids = opt_in_recipients(db, uids - {actor.id if actor else ""}, kind)
    for uid in uids:
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
