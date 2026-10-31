"""Brücke zu externen Chat-Diensten (Discord, Matrix …).

Die Seite kennt nur ein neutrales Protokoll; ein Client (z. B. der Red-Discord-Bot) holt Nachrichten aus der
Outbox ab und liefert Eingehendes über ``/bridge/inbound``. Der Client ruft immer die Seite an – die Seite muss
ihn nie erreichen. Ein neuer Dienst braucht daher nur einen neuen Client mit anderem ``provider``-Namen.
"""
from __future__ import annotations

import secrets
from datetime import timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..models import (
    BridgeCode,
    BridgeIdentity,
    BridgeLink,
    BridgeOutbox,
    Conversation,
    ConversationMember,
    Message,
    User,
    now,
)
from . import mentions as mentions_svc
from . import notify

CODE_TTL = timedelta(minutes=15)
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # ohne 0/O/1/I
MAX_TEXT = 5000


def enqueue(db: Session, conv: Conversation, msg: Message, author: str) -> int:
    """Stellt eine neue Nachricht für alle verbundenen externen Räume bereit (außer dem, aus dem sie kam)."""
    n = 0
    for link in db.scalars(select(BridgeLink).where(BridgeLink.conversation_id == conv.id)):
        if link.provider == msg.origin:
            continue
        db.add(BridgeOutbox(provider=link.provider, external_id=link.external_id, author=author[:100], text=msg.text))
        n += 1
    return n


def new_code(db: Session, kind: str, user_id: str, conversation_id: str | None = None) -> BridgeCode:
    db.execute(delete(BridgeCode).where(BridgeCode.expires_at < now()))
    db.execute(delete(BridgeCode).where(BridgeCode.user_id == user_id, BridgeCode.kind == kind,
                                        BridgeCode.conversation_id == conversation_id))
    code = BridgeCode(code="".join(secrets.choice(_ALPHABET) for _ in range(8)), kind=kind, user_id=user_id,
                      conversation_id=conversation_id, expires_at=now() + CODE_TTL)
    db.add(code)
    return code


def ingest(db: Session, provider: str, channel_id: str, author_id: str, author_name: str, text: str) -> Message | None:
    """Nachricht aus einem verbundenen externen Raum übernehmen. None = Raum ist nicht verbunden."""
    link = db.scalar(select(BridgeLink).where(BridgeLink.provider == provider, BridgeLink.external_id == channel_id))
    if link is None:
        return None
    conv = db.get(Conversation, link.conversation_id)
    if conv is None:
        return None
    text = text.strip()[:MAX_TEXT]
    if not text:
        return None
    ident = db.scalar(select(BridgeIdentity).where(BridgeIdentity.provider == provider,
                                                   BridgeIdentity.external_id == author_id))
    user = db.get(User, ident.user_id) if ident else None
    member = user is not None and user.is_active and db.get(ConversationMember, (conv.id, user.id)) is not None
    pid = conv.source_id if conv.source_type == "project" else None
    ments = mentions_svc.resolve_mentions(db, text, pid)
    msg = Message(conversation_id=conv.id, user_id=user.id if member else None, text=text, mentions=ments,
                  origin=provider, ext_author="" if member else f"{author_name[:70]} ({provider.capitalize()})")
    db.add(msg)
    conv.updated_at = now()
    if ments:
        rec = mentions_svc.mention_recipients(db, pid, ments, exclude=user.id if member else "") if pid else _chat_recipients(db, ments)
        members = set(db.scalars(select(ConversationMember.user_id).where(ConversationMember.conversation_id == conv.id)))
        notify.send(db, rec & members, "chat_mention", actor=user if member else None, title=conv.name or "", text=text,
                    conversation_id=conv.id)
    db.flush()
    # An weitere verbundene Räume (anderer Dienst) weiterreichen
    enqueue(db, conv, msg, user.label if member and user else msg.ext_author)
    return msg


def _chat_recipients(db: Session, ments: list[dict]) -> set[str]:
    from ..routers.chat import _chat_recipients as rec  # gleiche Auflösung wie im Web-Chat

    return rec(db, ments, "")
