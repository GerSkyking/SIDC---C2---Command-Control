"""Externe Benachrichtigungskanäle des angemeldeten Nutzers (Discord, ntfy, Matrix, Web-Push …)."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from ..deps import CurrentUser, DbDep
from ..models import NotificationChannel, now
from ..services import channels as ch

router = APIRouter(prefix="/notify", tags=["notify"])

_MAX_CHANNELS = 10
KINDS = ("task_mention", "chat_mention", "assigned")


class ChannelIn(BaseModel):
    type: str = Field(max_length=16)
    name: str = Field(default="", max_length=80)
    config: dict = Field(default_factory=dict)
    kinds: list[Literal["task_mention", "chat_mention", "assigned"]] = Field(default_factory=list)


class ChannelPatch(BaseModel):
    name: str | None = Field(default=None, max_length=80)
    config: dict | None = None
    kinds: list[Literal["task_mention", "chat_mention", "assigned"]] | None = None
    enabled: bool | None = None


class PushKeys(BaseModel):
    p256dh: str = Field(max_length=200)
    auth: str = Field(max_length=100)


class PushSubIn(BaseModel):
    endpoint: str = Field(max_length=1000)
    keys: PushKeys
    name: str = Field(default="", max_length=80)


def _iso(dt):
    return dt.isoformat().replace("+00:00", "") + "Z" if dt else None


def _out(c: NotificationChannel) -> dict:
    return {"id": c.id, "type": c.type, "name": c.name, "kinds": c.kinds or [], "enabled": c.enabled,
            "config": ch.public_config(c.type, c.config), "last_ok_at": _iso(c.last_ok_at), "last_error": c.last_error}


def _own(db, user, cid: str) -> NotificationChannel:
    c = db.get(NotificationChannel, cid)
    if c is None or c.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Kanal nicht gefunden")
    return c


def _count(db, user) -> int:
    return int(db.scalar(select(func.count(NotificationChannel.id)).where(NotificationChannel.user_id == user.id)) or 0)


@router.get("/types")
def types(user: CurrentUser) -> dict:
    return {"types": ch.type_info(), "kinds": list(KINDS)}


@router.get("/channels")
def list_channels(user: CurrentUser, db: DbDep) -> list[dict]:
    rows = db.scalars(select(NotificationChannel).where(NotificationChannel.user_id == user.id)
                      .order_by(NotificationChannel.created_at))
    return [_out(c) for c in rows]


@router.post("/channels", status_code=status.HTTP_201_CREATED)
def create_channel(body: ChannelIn, user: CurrentUser, db: DbDep) -> dict:
    prov = ch.REGISTRY.get(body.type)
    if prov is None or not prov.form or not prov.available():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Kanal-Typ nicht verfügbar")
    if _count(db, user) >= _MAX_CHANNELS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Zu viele Kanäle")
    try:
        cfg = ch.seal_config(body.type, body.config)
    except ch.ChannelError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    c = NotificationChannel(user_id=user.id, type=body.type, name=body.name.strip() or prov.label, config=cfg,
                            kinds=list(body.kinds))
    db.add(c)
    db.commit()
    return _out(c)


@router.patch("/channels/{cid}")
def patch_channel(cid: str, body: ChannelPatch, user: CurrentUser, db: DbDep) -> dict:
    c = _own(db, user, cid)
    if body.name is not None:
        c.name = body.name.strip() or ch.REGISTRY[c.type].label
    if body.kinds is not None:
        c.kinds = list(body.kinds)
    if body.enabled is not None:
        c.enabled = body.enabled
    if body.config is not None and ch.REGISTRY[c.type].form:
        try:
            c.config = ch.seal_config(c.type, body.config, old=c.config)
        except ch.ChannelError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        c.last_error = ""
    db.commit()
    return _out(c)


@router.delete("/channels/{cid}")
def delete_channel(cid: str, user: CurrentUser, db: DbDep) -> dict:
    db.delete(_own(db, user, cid))
    db.commit()
    return {"ok": True}


@router.post("/channels/{cid}/test")
def test_channel(cid: str, user: CurrentUser, db: DbDep) -> dict:
    c = _own(db, user, cid)
    msg = ch.Msg(kind="test", headline="SIDC C2: Testnachricht", text=f"Hallo {user.label}, dieser Kanal funktioniert.",
                 actor=user.label)
    try:
        ch.send_to(c.type, c.config, msg)
    except ch.ChannelError as exc:
        c.last_error = str(exc)[:300]
        db.commit()
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
    c.last_ok_at, c.last_error = now(), ""
    db.commit()
    return {"ok": True}


# ─── Web-Push ────────────────────────────────────────────────────────────────

@router.get("/webpush/key")
def webpush_key(user: CurrentUser) -> dict:
    return {"key": ch.vapid_public_key()}


@router.post("/webpush", status_code=status.HTTP_201_CREATED)
def webpush_subscribe(body: PushSubIn, user: CurrentUser, db: DbDep) -> dict:
    """Registriert den Browser; dieselbe Browser-Registrierung wird nur einmal angelegt."""
    try:
        ch.check_url(body.endpoint)
    except ch.ChannelError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    rows = list(db.scalars(select(NotificationChannel).where(
        NotificationChannel.user_id == user.id, NotificationChannel.type == "webpush")))
    cfg = ch.seal_config("webpush", {"endpoint": body.endpoint, "p256dh": body.keys.p256dh, "auth": body.keys.auth})
    for c in rows:
        if ch.open_config("webpush", c.config).get("endpoint") == body.endpoint:
            c.config, c.enabled, c.last_error = cfg, True, ""
            db.commit()
            return _out(c)
    if _count(db, user) >= _MAX_CHANNELS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Zu viele Kanäle")
    c = NotificationChannel(user_id=user.id, type="webpush", name=body.name.strip() or "Browser", config=cfg, kinds=[])
    db.add(c)
    db.commit()
    return _out(c)
