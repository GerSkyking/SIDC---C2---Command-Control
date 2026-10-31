"""Brücken-Schnittstelle: (a) für Nutzer – Konto/Chat mit Discord & Co. verbinden, (b) für den Bot (Bearer-Token)."""
from __future__ import annotations

import secrets
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

from ..config import get_settings
from ..deps import CurrentUser, DbDep
from ..models import (
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
    rows = db.scalars(select(BridgeLink).where(BridgeLink.conversation_id == cid))
    return [{"id": r.id, "provider": r.provider, "external_id": r.external_id} for r in rows]


@router.delete("/links/{lid}")
def delete_link(lid: str, user: CurrentUser, db: DbDep) -> dict:
    link = db.get(BridgeLink, lid)
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Verbindung nicht gefunden")
    _can_link(db, user, link.conversation_id)
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
