"""Liefert offene Benachrichtigungen an die externen Kanäle der Empfänger aus.

Entkoppelt von den Anfragen: ``notify.send`` legt nur Zeilen an, dieser Hintergrund-Task (``run``) holt sie
nach dem Commit ab. Mehrere Worker-Prozesse sind unkritisch – jede Zeile wird per ``UPDATE … WHERE
dispatched_at IS NULL`` genau einmal übernommen.
"""
from __future__ import annotations

import asyncio
import logging
from urllib.parse import quote

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import SessionLocal
from ..models import Notification, NotificationChannel, User, now
from . import channels

log = logging.getLogger("sidc.dispatch")

_INTERVAL_S = 3.0
_BATCH = 50


def _link(n: Notification) -> str:
    base = get_settings().public_url.rstrip("/")
    if not base:
        return ""
    if n.conversation_id:
        return f"{base}/#/chat/{quote(n.conversation_id)}"
    if n.project_id:
        return f"{base}/#/projects/{quote(n.project_id)}/tasks"
    return f"{base}/#/chat/system"


def _headline(n: Notification, actor: str) -> str:
    who = actor or "Jemand"
    t = n.title or "…"
    if n.kind == "assigned":
        return f"{who} hat dir „{t}“ zugewiesen"
    if n.kind == "chat_mention":
        return f"{who} hat dich im Chat{(' „' + t + '“') if n.title else ''} erwähnt"
    return f"{who} hat dich in „{t}“ erwähnt"


def deliver(db: Session, n: Notification, actor_label: str = "") -> int:
    """Schickt eine Benachrichtigung an alle passenden, aktiven Kanäle des Empfängers. Gibt die Zahl der Erfolge zurück."""
    msg = channels.Msg(kind=n.kind, headline=_headline(n, actor_label), text=n.text or "", url=_link(n), actor=actor_label)
    rows = list(db.scalars(select(NotificationChannel).where(
        NotificationChannel.user_id == n.user_id, NotificationChannel.enabled.is_(True))))
    ok = 0
    for ch in rows:
        if ch.kinds and n.kind not in ch.kinds:
            continue
        try:
            channels.send_to(ch.type, ch.config, msg)
            ch.last_ok_at, ch.last_error = now(), ""
            ok += 1
        except channels.ChannelGone:
            db.delete(ch)  # z. B. abgelaufene Web-Push-Registrierung
        except channels.ChannelError as exc:
            ch.last_error = str(exc)[:300]
        except Exception as exc:  # noqa: BLE001 - ein defekter Kanal darf die anderen nicht blockieren
            log.exception("Kanal %s (%s) fehlgeschlagen", ch.id, ch.type)
            ch.last_error = f"{type(exc).__name__}"[:300]
    return ok


def dispatch_pending(db: Session) -> int:
    ids = list(db.scalars(select(Notification.id).where(Notification.dispatched_at.is_(None))
                          .order_by(Notification.created_at).limit(_BATCH)))
    done = 0
    for nid in ids:
        res = db.execute(update(Notification).where(Notification.id == nid, Notification.dispatched_at.is_(None))
                         .values(dispatched_at=now()))
        db.commit()
        if res.rowcount != 1:
            continue  # ein anderer Worker war schneller
        n = db.get(Notification, nid)
        if n is None or n.read_at is not None:
            continue  # bereits gesehen
        actor = db.get(User, n.actor_id) if n.actor_id else None
        try:
            deliver(db, n, actor.label if actor else "")
            db.commit()
            done += 1
        except Exception:  # noqa: BLE001
            db.rollback()
            log.exception("Zustellung %s fehlgeschlagen", nid)
    return done


def _tick() -> None:
    with SessionLocal() as db:
        dispatch_pending(db)


async def run() -> None:
    while True:
        try:
            await asyncio.to_thread(_tick)
        except Exception:  # noqa: BLE001
            log.exception("Dispatcher-Lauf fehlgeschlagen")
        await asyncio.sleep(_INTERVAL_S)
