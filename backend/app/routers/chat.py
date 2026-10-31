"""Chat (Direkt, Gruppen, Projekt-/Admin-Gruppen) + System-Feed mit Benachrichtigungen.

Zustellung per Polling (wie die Projektseiten). Gruppen-Chats können an eine bestehende Admin-Gruppe
oder ein Projekt gebunden sein; deren Mitglieder werden dann bei jedem Zugriff abgeglichen.
Alle Endpunkte sind plain ``def`` (Threadpool).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy import delete as sa_delete
from sqlalchemy.orm import Session

from ..deps import CurrentUser, DbDep
from ..models import (
    Conversation,
    ConversationMember,
    Group,
    GroupMember,
    Message,
    Notification,
    Project,
    User,
    now,
)
from ..permissions import project_role
from ..services import mentions as mentions_svc
from ..services import notify

router = APIRouter(prefix="/chat", tags=["chat"])

_MAX_MEMBERS = 200
_MAX_CONVS = 300


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.isoformat() + "Z"


def _naive(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc).replace(tzinfo=None) if dt.tzinfo else dt


def _labels(db: Session, ids) -> dict[str, str]:
    ids = {i for i in ids if i}
    return {u.id: u.label for u in db.scalars(select(User).where(User.id.in_(ids)))} if ids else {}


# ─── Schemas ───────────────────────────────────────────────────────────────

class ConvCreateIn(BaseModel):
    kind: Literal["dm", "group"]
    user_id: str | None = None                     # dm
    name: str = Field(default="", max_length=80)    # group
    member_ids: list[str] = Field(default_factory=list, max_length=_MAX_MEMBERS)
    source_type: Literal["group", "project"] | None = None
    source_id: str | None = None


class ConvPatchIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)


class ConvMembersIn(BaseModel):
    add: list[str] = Field(default_factory=list, max_length=_MAX_MEMBERS)
    remove: list[str] = Field(default_factory=list, max_length=_MAX_MEMBERS)


class MessageIn(BaseModel):
    text: str = Field(min_length=1, max_length=5000)


class ReadIn(BaseModel):
    ids: list[str] = Field(default_factory=list, max_length=500)
    all: bool = False


# ─── Zugriff / Abgleich ────────────────────────────────────────────────────

def _source_user_ids(db: Session, conv: Conversation) -> set[str] | None:
    if conv.source_type == "group":
        ids = set(db.scalars(select(GroupMember.user_id).where(GroupMember.group_id == conv.source_id)))
    elif conv.source_type == "project":
        ids = mentions_svc.project_user_ids(db, conv.source_id)
    else:
        return None
    return set(db.scalars(select(User.id).where(User.id.in_(ids), User.is_active.is_(True)))) if ids else set()


def _sync_members(db: Session, conv: Conversation) -> None:
    """Mitglieder einer an Gruppe/Projekt gebundenen Unterhaltung mit der Quelle abgleichen."""
    want = _source_user_ids(db, conv)
    if want is None:
        return
    have = {m.user_id: m for m in db.scalars(select(ConversationMember).where(ConversationMember.conversation_id == conv.id))}
    changed = False
    for uid in want - set(have):
        db.add(ConversationMember(conversation_id=conv.id, user_id=uid, last_read_at=now()))
        changed = True
    for uid, m in have.items():
        if uid not in want:
            db.delete(m)
            changed = True
    if changed:
        db.commit()


def _conv_for(db: Session, user: User, cid: str) -> tuple[Conversation, ConversationMember]:
    conv = db.get(Conversation, cid)
    if conv is not None and conv.source_type:
        _sync_members(db, conv)
    mem = db.get(ConversationMember, (cid, user.id)) if conv else None
    if conv is None or mem is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unterhaltung nicht gefunden")
    return conv, mem


def _member_ids(db: Session, cid: str) -> set[str]:
    return set(db.scalars(select(ConversationMember.user_id).where(ConversationMember.conversation_id == cid)))


def _snippet(text: str) -> str:
    return " ".join(text.split())[:80]


# ─── Ausgabe ───────────────────────────────────────────────────────────────

def _conv_out(db: Session, user: User, conv: Conversation, mem: ConversationMember) -> dict:
    members = list(db.scalars(select(ConversationMember.user_id).where(ConversationMember.conversation_id == conv.id)))
    labels = _labels(db, members)
    name = conv.name
    other_id = None
    if conv.kind == "dm":
        other_id = next((m for m in members if m != user.id), user.id)
        name = labels.get(other_id, "?")
    last = db.scalar(select(Message).where(Message.conversation_id == conv.id).order_by(Message.created_at.desc()).limit(1))
    q = select(func.count(Message.id)).where(Message.conversation_id == conv.id, Message.user_id != user.id)
    if mem.last_read_at is not None:
        q = q.where(Message.created_at > mem.last_read_at)
    return {
        "id": conv.id, "kind": conv.kind, "name": name, "source_type": conv.source_type, "source_id": conv.source_id,
        "other_user_id": other_id, "member_count": len(members), "is_owner": conv.created_by == user.id,
        "unread": int(db.scalar(q) or 0),
        "updated_at": _iso(conv.updated_at),
        "last": ({"text": _snippet(last.text), "user_label": _labels(db, [last.user_id]).get(last.user_id or ""),
                  "created_at": _iso(last.created_at)} if last else None),
    }


def _msg_out(m: Message, labels: dict[str, str], user: User) -> dict:
    return {
        "id": m.id, "user_id": m.user_id, "user_label": labels.get(m.user_id or "", None), "text": m.text,
        "mentions": m.mentions or [], "created_at": _iso(m.created_at), "edited_at": _iso(m.edited_at),
        "mine": m.user_id == user.id,
    }


# ─── Unterhaltungen ────────────────────────────────────────────────────────

@router.get("/conversations")
def list_conversations(user: CurrentUser, db: DbDep) -> list[dict]:
    mems = list(db.scalars(select(ConversationMember).where(ConversationMember.user_id == user.id)))
    out = []
    for mem in mems:
        conv = db.get(Conversation, mem.conversation_id)
        if conv is None:
            continue
        if conv.source_type:
            _sync_members(db, conv)
            if db.get(ConversationMember, (conv.id, user.id)) is None:
                continue  # aus der Quelle (Gruppe/Projekt) entfernt
        out.append(_conv_out(db, user, conv, mem))
    out.sort(key=lambda c: c["updated_at"] or "", reverse=True)
    return out


@router.get("/users")
def chat_users(user: CurrentUser, db: DbDep, q: str = "") -> dict:
    """Aktive Nutzer (außer mir) und Gruppen zum Starten von Chats."""
    ql = q.strip().lower()
    users = [u for u in db.scalars(select(User).where(User.is_active.is_(True), User.id != user.id))
             if not ql or ql in u.label.lower() or ql in u.username.lower()]
    users.sort(key=lambda u: u.label.lower())
    my_groups = {g.id for g in user.groups}
    groups = [g for g in db.scalars(select(Group)) if (user.is_admin or g.id in my_groups) and (not ql or ql in g.name.lower())]
    projects = []
    for p in db.scalars(select(Project).where(Project.archived.is_(False))):
        if (not ql or ql in p.name.lower()) and project_role(db, user, p.id) is not None:
            projects.append({"id": p.id, "name": p.name})
    return {
        "users": [{"id": u.id, "label": u.label, "username": u.username} for u in users[:100]],
        "groups": [{"id": g.id, "name": g.name} for g in sorted(groups, key=lambda g: g.name.lower())],
        "projects": sorted(projects, key=lambda p: p["name"].lower()),
    }


@router.post("/conversations", status_code=status.HTTP_201_CREATED)
def create_conversation(body: ConvCreateIn, user: CurrentUser, db: DbDep) -> dict:
    if len(list(db.scalars(select(ConversationMember.conversation_id).where(ConversationMember.user_id == user.id)))) >= _MAX_CONVS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Zu viele Unterhaltungen")
    if body.kind == "dm":
        other = db.get(User, body.user_id) if body.user_id else None
        if other is None or not other.is_active or other.id == user.id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ungültiger Gesprächspartner")
        key = ":".join(sorted((user.id, other.id)))
        conv = db.scalar(select(Conversation).where(Conversation.dm_key == key))
        if conv is None:
            conv = Conversation(kind="dm", dm_key=key, created_by=user.id)
            db.add(conv)
            db.flush()
            for uid in (user.id, other.id):
                db.add(ConversationMember(conversation_id=conv.id, user_id=uid, last_read_at=now()))
            db.commit()
        return _conv_out(db, user, conv, db.get(ConversationMember, (conv.id, user.id)))

    name = body.name.strip()
    src_name = ""
    if body.source_type == "group":
        g = db.get(Group, body.source_id) if body.source_id else None
        if g is None or not (user.is_admin or any(x.id == g.id for x in user.groups)):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Gruppe nicht verfügbar")
        src_name = g.name
    elif body.source_type == "project":
        p = db.get(Project, body.source_id) if body.source_id else None
        if p is None or project_role(db, user, p.id) is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Projekt nicht verfügbar")
        src_name = p.name
    elif not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Name fehlt")
    conv = Conversation(kind="group", name=name or src_name, source_type=body.source_type,
                        source_id=body.source_id if body.source_type else None, created_by=user.id)
    db.add(conv)
    db.flush()
    ids = {user.id}
    for uid in body.member_ids:
        u = db.get(User, uid)
        if u is not None and u.is_active:
            ids.add(uid)
    for uid in ids:
        db.add(ConversationMember(conversation_id=conv.id, user_id=uid, last_read_at=now()))
    db.commit()
    if conv.source_type:
        _sync_members(db, conv)
    conv, mem = _conv_for(db, user, conv.id)
    return _conv_out(db, user, conv, mem)


@router.patch("/conversations/{cid}")
def patch_conversation(cid: str, body: ConvPatchIn, user: CurrentUser, db: DbDep) -> dict:
    conv, mem = _conv_for(db, user, cid)
    if conv.kind != "group" or conv.created_by != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Nur der Ersteller kann die Gruppe ändern")
    if body.name is not None:
        conv.name = body.name.strip()
    db.commit()
    return _conv_out(db, user, conv, mem)


@router.get("/conversations/{cid}/members")
def conversation_members(cid: str, user: CurrentUser, db: DbDep) -> list[dict]:
    conv, _ = _conv_for(db, user, cid)
    ids = _member_ids(db, conv.id)
    labels = _labels(db, ids)
    return sorted(({"user_id": i, "label": labels.get(i, "?"), "is_owner": i == conv.created_by} for i in ids),
                  key=lambda x: x["label"].lower())


@router.put("/conversations/{cid}/members")
def put_conversation_members(cid: str, body: ConvMembersIn, user: CurrentUser, db: DbDep) -> list[dict]:
    conv, _ = _conv_for(db, user, cid)
    if conv.kind != "group" or conv.source_type or conv.created_by != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Mitglieder nur in eigenen, freien Gruppen änderbar")
    have = _member_ids(db, conv.id)
    for uid in body.add:
        u = db.get(User, uid)
        if u is not None and u.is_active and uid not in have:
            if len(have) >= _MAX_MEMBERS:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Zu viele Mitglieder")
            db.add(ConversationMember(conversation_id=conv.id, user_id=uid, last_read_at=now()))
            have.add(uid)
    for uid in body.remove:
        if uid != conv.created_by and uid in have:
            db.execute(sa_delete(ConversationMember).where(
                ConversationMember.conversation_id == conv.id, ConversationMember.user_id == uid))
    db.commit()
    return conversation_members(cid, user, db)


@router.post("/conversations/{cid}/leave")
def leave_conversation(cid: str, user: CurrentUser, db: DbDep) -> dict:
    conv, mem = _conv_for(db, user, cid)
    if conv.kind != "group" or conv.source_type:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Hier kann man nicht austreten")
    db.delete(mem)
    db.commit()
    return {"ok": True}


@router.post("/conversations/{cid}/read")
def mark_read(cid: str, user: CurrentUser, db: DbDep) -> dict:
    _, mem = _conv_for(db, user, cid)
    mem.last_read_at = now()
    db.commit()
    return {"ok": True}


@router.get("/conversations/{cid}/mentionables")
def conversation_mentionables(cid: str, user: CurrentUser, db: DbDep) -> list[dict]:
    conv, _ = _conv_for(db, user, cid)
    pid = conv.source_id if conv.source_type == "project" else None
    members = _member_ids(db, conv.id)
    cands = mentions_svc.mention_candidates(db, pid)
    return [c for c in cands if c["type"] != "user" or c["id"] in members]


# ─── Nachrichten ───────────────────────────────────────────────────────────

@router.get("/conversations/{cid}/messages")
def list_messages(
    cid: str, user: CurrentUser, db: DbDep, limit: Annotated[int, Query(ge=1, le=200)] = 60,
    before: datetime | None = None, after: datetime | None = None,
) -> list[dict]:
    """Älteste zuerst. Ohne Parameter die letzten `limit`; `before` blättert zurück, `after` liefert Neues."""
    _conv_for(db, user, cid)
    q = select(Message).where(Message.conversation_id == cid)
    if after is not None:
        q = q.where(Message.created_at > after).order_by(Message.created_at).limit(limit)
        rows = list(db.scalars(q))
    else:
        if before is not None:
            q = q.where(Message.created_at < before)
        rows = list(db.scalars(q.order_by(Message.created_at.desc()).limit(limit)))[::-1]
    labels = _labels(db, [m.user_id for m in rows])
    return [_msg_out(m, labels, user) for m in rows]


@router.post("/conversations/{cid}/messages", status_code=status.HTTP_201_CREATED)
def post_message(cid: str, body: MessageIn, user: CurrentUser, db: DbDep) -> dict:
    conv, mem = _conv_for(db, user, cid)
    text = body.text.strip()
    if not text:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Text fehlt")
    pid = conv.source_id if conv.source_type == "project" else None
    ments = mentions_svc.resolve_mentions(db, text, pid)
    m = Message(conversation_id=cid, user_id=user.id, text=text, mentions=ments)
    db.add(m)
    conv.updated_at = now()
    mem.last_read_at = now()
    if ments:
        rec = mentions_svc.mention_recipients(db, pid, ments, exclude=user.id) if pid else _chat_recipients(db, ments, user.id)
        rec &= _member_ids(db, cid)
        notify.send(db, rec, "chat_mention", actor=user, title=conv.name or "", text=text, conversation_id=cid)
    db.commit()
    return _msg_out(m, _labels(db, [user.id]), user)


def _chat_recipients(db: Session, ments: list[dict], exclude: str) -> set[str]:
    ids: set[str] = set()
    for x in ments:
        if x["type"] == "user":
            ids.add(x["id"])
        elif x["type"] == "group":
            ids.update(db.scalars(select(GroupMember.user_id).where(GroupMember.group_id == x["id"])))
    ids.discard(exclude)
    return ids


def _own_message(db: Session, user: User, cid: str, mid: str) -> Message:
    _conv_for(db, user, cid)
    m = db.get(Message, mid)
    if m is None or m.conversation_id != cid:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nachricht nicht gefunden")
    if m.user_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Nur eigene Nachrichten")
    return m


@router.patch("/conversations/{cid}/messages/{mid}")
def edit_message(cid: str, mid: str, body: MessageIn, user: CurrentUser, db: DbDep) -> dict:
    m = _own_message(db, user, cid, mid)
    text = body.text.strip()
    if not text:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Text fehlt")
    if text != m.text:
        conv = db.get(Conversation, cid)
        pid = conv.source_id if conv.source_type == "project" else None
        m.text = text
        m.mentions = mentions_svc.resolve_mentions(db, text, pid)
        m.edited_at = now()
        db.commit()
    return _msg_out(m, _labels(db, [user.id]), user)


@router.delete("/conversations/{cid}/messages/{mid}")
def delete_message(cid: str, mid: str, user: CurrentUser, db: DbDep) -> dict:
    m = _own_message(db, user, cid, mid)
    db.delete(m)
    db.commit()
    return {"ok": True}


# ─── System-Feed / Benachrichtigungen ──────────────────────────────────────

@router.get("/unread")
def unread(user: CurrentUser, db: DbDep) -> dict:
    """Zähler für das Badge in der Seitenleiste."""
    chats = 0
    for mem in db.scalars(select(ConversationMember).where(ConversationMember.user_id == user.id)):
        q = select(func.count(Message.id)).where(Message.conversation_id == mem.conversation_id, Message.user_id != user.id)
        if mem.last_read_at is not None:
            q = q.where(Message.created_at > mem.last_read_at)
        chats += int(db.scalar(q) or 0)
    notes = int(db.scalar(select(func.count(Notification.id)).where(
        Notification.user_id == user.id, Notification.read_at.is_(None))) or 0)
    return {"chats": chats, "notifications": notes, "total": chats + notes}


@router.get("/notifications")
def list_notifications(
    user: CurrentUser, db: DbDep, limit: Annotated[int, Query(ge=1, le=200)] = 60, before: datetime | None = None,
) -> list[dict]:
    q = select(Notification).where(Notification.user_id == user.id)
    if before is not None:
        q = q.where(Notification.created_at < before)
    rows = list(db.scalars(q.order_by(Notification.created_at.desc()).limit(limit)))
    labels = _labels(db, [n.actor_id for n in rows])
    pids = {n.project_id for n in rows if n.project_id}
    pnames = {p.id: p.name for p in db.scalars(select(Project).where(Project.id.in_(pids)))} if pids else {}
    return [{
        "id": n.id, "kind": n.kind, "actor_id": n.actor_id, "actor_label": labels.get(n.actor_id or "", None),
        "title": n.title, "text": n.text, "project_id": n.project_id, "project_name": pnames.get(n.project_id or "", None),
        "task_id": n.task_id, "conversation_id": n.conversation_id,
        "read": n.read_at is not None, "created_at": _iso(n.created_at),
    } for n in rows]


@router.post("/notifications/read")
def read_notifications(body: ReadIn, user: CurrentUser, db: DbDep) -> dict:
    q = select(Notification).where(Notification.user_id == user.id, Notification.read_at.is_(None))
    if not body.all:
        q = q.where(Notification.id.in_(body.ids or [""]))
    for n in db.scalars(q):
        n.read_at = now()
    db.commit()
    return {"ok": True}


@router.delete("/notifications")
def clear_read_notifications(user: CurrentUser, db: DbDep) -> dict:
    """Gelesene Benachrichtigungen entfernen."""
    db.execute(sa_delete(Notification).where(Notification.user_id == user.id, Notification.read_at.is_not(None)))
    db.commit()
    return {"ok": True}
