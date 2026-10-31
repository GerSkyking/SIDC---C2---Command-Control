"""Brücken-Schnittstelle: (a) für Nutzer – Konto/Chat mit Discord & Co. verbinden, (b) für den Bot (Bearer-Token)."""
from __future__ import annotations

import secrets
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

from ..config import get_settings
from ..deps import AdminUser, CurrentUser, DbDep
from ..models import (
    BridgeChannel,
    BridgeCode,
    BridgeIdentity,
    BridgeLink,
    BridgeOutbox,
    Conversation,
    ConversationMember,
    User,
    now,
)
from ..services import bridge as svc

router = APIRouter(prefix="/bridge", tags=["bridge"])

PROVIDERS = ("discord", "matrix")


def _iso(dt):
    return dt.isoformat().replace("+00:00", "") + "Z" if dt else None


# ─── Für Nutzer ──────────────────────────────────────────────────────────────

class CodeIn(BaseModel):
    kind: str = Field(pattern="^(user|conv)$")
    conversation_id: str | None = None


def _can_link(db, user: User, cid: str) -> Conversation:
    conv = db.get(Conversation, cid)
    if conv is None or db.get(ConversationMember, (cid, user.id)) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unterhaltung nicht gefunden")
    if conv.kind != "group":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nur Gruppen-Chats lassen sich verbinden")
    if conv.created_by != user.id and not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Nur der Ersteller (oder ein Admin) darf den Chat verbinden")
    return conv


@router.get("/me")
def my_bridge(user: CurrentUser, db: DbDep) -> dict:
    ids = db.scalars(select(BridgeIdentity).where(BridgeIdentity.user_id == user.id))
    return {"enabled": bool(get_settings().bridge_token),
            "identities": [{"provider": i.provider, "external_id": i.external_id} for i in ids]}


@router.post("/code")
def make_code(body: CodeIn, user: CurrentUser, db: DbDep) -> dict:
    if not get_settings().bridge_token:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Brücke ist nicht eingerichtet (BRIDGE_TOKEN)")
    if body.kind == "conv":
        if not body.conversation_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "conversation_id fehlt")
        _can_link(db, user, body.conversation_id)
    code = svc.new_code(db, body.kind, user.id, body.conversation_id if body.kind == "conv" else None)
    db.commit()
    return {"code": code.code, "expires_in": int(svc.CODE_TTL.total_seconds())}


@router.delete("/identities/{provider}")
def unlink_identity(provider: str, user: CurrentUser, db: DbDep) -> dict:
    db.execute(delete(BridgeIdentity).where(BridgeIdentity.user_id == user.id, BridgeIdentity.provider == provider))
    db.commit()
    return {"ok": True}


@router.get("/conversations/{cid}/links")
def conversation_links(cid: str, user: CurrentUser, db: DbDep) -> list[dict]:
    if db.get(ConversationMember, (cid, user.id)) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unterhaltung nicht gefunden")
    rows = list(db.scalars(select(BridgeLink).where(BridgeLink.conversation_id == cid)))
    return [{"id": r.id, "provider": r.provider, "external_id": r.external_id, **_chan_label(db, r.provider, r.external_id)}
            for r in rows]


@router.delete("/links/{lid}")
def delete_link(lid: str, user: CurrentUser, db: DbDep) -> dict:
    link = db.get(BridgeLink, lid)
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Verbindung nicht gefunden")
    _can_link(db, user, link.conversation_id)
    db.delete(link)
    db.commit()
    return {"ok": True}


def _chan_label(db, provider: str, external_id: str) -> dict:
    ch = db.scalar(select(BridgeChannel).where(BridgeChannel.provider == provider,
                                               BridgeChannel.external_id == external_id))
    return {"channel_name": ch.name if ch else "", "group_name": ch.group_name if ch else ""}


# ─── Admin: Chats mit Kanälen verbinden ──────────────────────────────────────

class AdminLinkIn(BaseModel):
    conversation_id: str = Field(max_length=32)
    provider: str = Field(max_length=16)
    external_id: str = Field(max_length=64)


@router.get("/admin/overview")
def admin_overview(admin: AdminUser, db: DbDep) -> dict:
    chans = list(db.scalars(select(BridgeChannel).order_by(BridgeChannel.group_name, BridgeChannel.name)))
    convs = list(db.scalars(select(Conversation).where(Conversation.kind == "group").order_by(Conversation.name).limit(500)))
    names = {c.id: c.name for c in convs}
    links = list(db.scalars(select(BridgeLink)))
    by_ext = {(c.provider, c.external_id): c for c in chans}
    return {
        "enabled": bool(get_settings().bridge_token),
        "channels": [{"provider": c.provider, "external_id": c.external_id, "name": c.name, "group_name": c.group_name,
                      "updated_at": _iso(c.updated_at)} for c in chans],
        "conversations": [{"id": c.id, "name": c.name or "?"} for c in convs],
        "links": [{"id": link.id, "conversation_id": link.conversation_id,
                   "conversation_name": names.get(link.conversation_id) or db.get(Conversation, link.conversation_id).name,
                   "provider": link.provider, "external_id": link.external_id,
                   "channel_name": by_ext[(link.provider, link.external_id)].name if (link.provider, link.external_id) in by_ext else "",
                   "group_name": by_ext[(link.provider, link.external_id)].group_name if (link.provider, link.external_id) in by_ext else ""}
                  for link in links],
    }


@router.post("/admin/links", status_code=status.HTTP_201_CREATED)
def admin_link(body: AdminLinkIn, admin: AdminUser, db: DbDep) -> dict:
    conv = db.get(Conversation, body.conversation_id)
    if conv is None or conv.kind != "group":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nur Gruppen-Chats lassen sich verbinden")
    known = db.scalar(select(BridgeChannel).where(BridgeChannel.provider == body.provider,
                                                  BridgeChannel.external_id == body.external_id))
    if known is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Kanal ist dem Bot nicht bekannt")
    if db.scalar(select(BridgeLink).where(BridgeLink.provider == body.provider,
                                          BridgeLink.external_id == body.external_id)) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Dieser Kanal ist schon verbunden")
    link = BridgeLink(conversation_id=conv.id, provider=body.provider, external_id=body.external_id)
    db.add(link)
    db.commit()
    return {"id": link.id}


@router.delete("/admin/links/{lid}")
def admin_unlink(lid: str, admin: AdminUser, db: DbDep) -> dict:
    link = db.get(BridgeLink, lid)
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Verbindung nicht gefunden")
    db.delete(link)
    db.commit()
    return {"ok": True}


# ─── Für den Bot ─────────────────────────────────────────────────────────────

def bot_auth(authorization: Annotated[str | None, Header()] = None) -> None:
    token = get_settings().bridge_token
    given = (authorization or "").removeprefix("Bearer ").strip()
    if not token or not secrets.compare_digest(given.encode(), token.encode()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Ungültiges Brücken-Token")


Bot = Depends(bot_auth)


class InboundIn(BaseModel):
    provider: str = Field(max_length=16)
    channel_id: str = Field(max_length=64)
    author_id: str = Field(max_length=64)
    author_name: str = Field(default="", max_length=100)
    text: str = Field(max_length=20000)


class ClaimIn(BaseModel):
    provider: str = Field(max_length=16)
    code: str = Field(max_length=16)
    author_id: str = Field(max_length=64)
    channel_id: str | None = Field(default=None, max_length=64)


class AckIn(BaseModel):
    ids: list[str] = Field(max_length=200)


class ChannelIn(BaseModel):
    id: str = Field(max_length=64)
    name: str = Field(default="", max_length=120)
    group_id: str = Field(default="", max_length=64)
    group_name: str = Field(default="", max_length=120)


class ChannelsIn(BaseModel):
    provider: str = Field(max_length=16)
    channels: list[ChannelIn] = Field(max_length=5000)


@router.post("/channels", dependencies=[Bot])
def bot_channels(body: ChannelsIn, db: DbDep) -> dict:
    """Der Client meldet alle Räume, die er sieht; die Momentaufnahme ersetzt die bisherige."""
    have = {c.external_id: c for c in db.scalars(select(BridgeChannel).where(BridgeChannel.provider == body.provider))}
    seen = set()
    for ch in body.channels:
        seen.add(ch.id)
        row = have.get(ch.id)
        if row is None:
            row = BridgeChannel(provider=body.provider, external_id=ch.id)
            db.add(row)
        row.name, row.group_id, row.group_name, row.updated_at = ch.name, ch.group_id, ch.group_name, now()
    for ext, row in have.items():
        if ext not in seen:
            db.delete(row)
    db.commit()
    return {"ok": True, "count": len(seen)}


@router.get("/links", dependencies=[Bot])
def bot_links(db: DbDep, provider: str) -> list[str]:
    """Alle verbundenen Raum-IDs – damit der Bot nur dort mitliest."""
    return list(db.scalars(select(BridgeLink.external_id).where(BridgeLink.provider == provider)))


@router.post("/inbound", dependencies=[Bot])
def bot_inbound(body: InboundIn, db: DbDep) -> dict:
    msg = svc.ingest(db, body.provider, body.channel_id, body.author_id, body.author_name, body.text)
    if msg is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Raum nicht verbunden")
    db.commit()
    return {"ok": True, "id": msg.id}


@router.get("/outbox", dependencies=[Bot])
def bot_outbox(db: DbDep, provider: str, limit: Annotated[int, Query(ge=1, le=100)] = 50) -> list[dict]:
    db.execute(delete(BridgeOutbox).where(BridgeOutbox.delivered_at.is_not(None)))  # Altlasten
    rows = db.scalars(select(BridgeOutbox).where(BridgeOutbox.provider == provider, BridgeOutbox.delivered_at.is_(None))
                      .order_by(BridgeOutbox.created_at).limit(limit))
    out = [{"id": r.id, "channel_id": r.external_id, "author": r.author, "text": r.text} for r in rows]
    db.commit()
    return out


@router.post("/outbox/ack", dependencies=[Bot])
def bot_ack(body: AckIn, db: DbDep) -> dict:
    for r in db.scalars(select(BridgeOutbox).where(BridgeOutbox.id.in_(body.ids or [""]))):
        r.delivered_at = now()
    db.commit()
    return {"ok": True}


@router.post("/claim", dependencies=[Bot])
def bot_claim(body: ClaimIn, db: DbDep) -> dict:
    """Einmal-Code einlösen: verbindet das Konto des Code-Erstellers mit ``author_id`` bzw. den Chat mit ``channel_id``."""
    code = db.get(BridgeCode, body.code.strip().upper())
    if code is None or code.expires_at.replace(tzinfo=None) < now().replace(tzinfo=None):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Code ungültig oder abgelaufen")
    if code.kind == "user":
        taken = db.scalar(select(BridgeIdentity).where(BridgeIdentity.provider == body.provider,
                                                       BridgeIdentity.external_id == body.author_id))
        if taken is not None and taken.user_id != code.user_id:
            raise HTTPException(status.HTTP_409_CONFLICT, "Dieses Konto ist schon mit einem anderen Nutzer verbunden")
        db.execute(delete(BridgeIdentity).where(BridgeIdentity.user_id == code.user_id,
                                                BridgeIdentity.provider == body.provider))
        db.add(BridgeIdentity(user_id=code.user_id, provider=body.provider, external_id=body.author_id))
        user = db.get(User, code.user_id)
        result = {"kind": "user", "label": user.label if user else ""}
    else:
        if not body.channel_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Dieser Code verbindet einen Kanal – bitte im Kanal eingeben")
        if db.scalar(select(BridgeLink).where(BridgeLink.provider == body.provider,
                                              BridgeLink.external_id == body.channel_id)) is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, "Dieser Kanal ist schon verbunden")
        conv = db.get(Conversation, code.conversation_id) if code.conversation_id else None
        if conv is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Chat existiert nicht mehr")
        db.add(BridgeLink(conversation_id=conv.id, provider=body.provider, external_id=body.channel_id))
        result = {"kind": "conv", "label": conv.name}
    db.delete(code)
    db.commit()
    return result
