"""Missionsbau-Werkzeuge Phase 2: Feedback (intern + öffentliche Schnittstelle), Meilensteine,
Dokument-Kommentare und -Versionen. Spezifikation: docs/MISSIONSBAU-WERKZEUGE.md.

Rechte: Mitglieder lesen; Feedback und Kommentare dürfen auch Betrachter schreiben; Status/Notiz,
Meilensteine und Wiederherstellen brauchen Editor, Löschen von Feedback und die Token-Verwaltung
Owner. Missionsbau-Dateien (und Bezüge darauf) bleiben für Nicht-Missionsbauer unsichtbar.
Der öffentliche Teil (ohne Login) gibt nur den Projektnamen preis. Alle Endpunkte sind plain ``def``.
"""
from __future__ import annotations

import logging
import re
import secrets
from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select

from ..deps import CurrentUser, DbDep
from ..models import (
    DocComment,
    Plan,
    Project,
    ProjectDoc,
    ProjectDocVersion,
    ProjectFeedback,
    ProjectMember,
    ProjectMilestone,
    ProjectTask,
    User,
    now,
)
from ..permissions import effective_level, effective_mission_builder, rank
from ..ratelimit import hit_limit
from ..schemas import CommentIn
from ..services import doc_versions as versions_svc
from ..services import mentions as mentions_svc
from ..services import notify
from ..services import refs as refs_svc
from ..services import timeline as timeline_svc
from .project_tools import _like as like_pattern
from .projects import (
    _MAX_COMMENTS,
    _MAX_TASKS,
    _act,
    _audit,
    _ctx,
    _doc_out,
    _get_doc,
    _iso,
    _labels,
    _set_status,
    _tasks_out,
    _validate_task_refs,
)

log = logging.getLogger("sidc.feedback")
router = APIRouter(prefix="/projects", tags=["project-feedback"])
public_router = APIRouter(prefix="/api/public/feedback", tags=["public"])

Kind = Literal["bug", "idea", "praise", "other"]
FbStatus = Literal["new", "doing", "done", "rejected"]
KINDS = ("bug", "idea", "praise", "other")
_MAX_FEEDBACK = 5000
_MAX_MILESTONES = 200
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{20,64}$")

# Öffentliche Schnittstelle: je Client-IP und je Token (Anzahl, Fenster in Sekunden)
_PUB_IP_POST = (10, 600.0)
_PUB_TOKEN_POST = (60, 3600.0)
_PUB_IP_GET = (120, 60.0)


# ─── Feedback (intern) ─────────────────────────────────────────────────────

class FeedbackIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    text: str = Field(default="", max_length=5000)
    kind: Kind = "other"
    plan_id: str | None = None
    doc_id: str | None = None


class FeedbackPatchIn(BaseModel):
    status: FbStatus | None = None
    kind: Kind | None = None
    note: str | None = Field(default=None, max_length=5000)


def _feedback_out(db, user: User, rows: list[ProjectFeedback]) -> list[dict]:
    """Bezüge auf Missionsbau-Dateien und nicht sichtbare Pläne werden für den Nutzer ausgeblendet."""
    is_b = effective_mission_builder(db, user)
    labels = _labels(db, [r.handled_by for r in rows])
    plan_ids = {r.plan_id for r in rows if r.plan_id}
    doc_ids = {r.doc_id for r in rows if r.doc_id}
    plans = {p.id: p for p in db.scalars(select(Plan).where(Plan.id.in_(plan_ids)))} if plan_ids else {}
    docs = {d.id: d for d in db.scalars(select(ProjectDoc).where(ProjectDoc.id.in_(doc_ids)))} if doc_ids else {}
    ok_plan = {i for i, p in plans.items() if p.deleted_at is None and effective_level(db, user, p) is not None}
    out = []
    for r in rows:
        d = docs.get(r.doc_id or "")
        doc_ok = d is not None and (is_b or d.space != "builder")
        out.append({
            "id": r.id, "title": r.title, "text": r.text, "kind": r.kind, "status": r.status, "source": r.source,
            "author_name": r.author_name, "author_user_id": r.author_user_id,
            "plan_id": r.plan_id if r.plan_id in ok_plan else None,
            "plan_name": plans[r.plan_id].name if r.plan_id in ok_plan else None,
            "doc_id": d.id if doc_ok else None, "doc_name": d.name if doc_ok else None,
            "doc_space": d.space if doc_ok else None,
            "task_id": r.task_id, "note": r.note,
            "handled_by": r.handled_by, "handled_by_label": labels.get(r.handled_by or "", None),
            "created_at": _iso(r.created_at), "updated_at": _iso(r.updated_at),
        })
    return out


def _get_feedback(db, pid: str, fid: str) -> ProjectFeedback:
    f = db.get(ProjectFeedback, fid)
    if f is None or f.project_id != pid:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Feedback nicht gefunden")
    return f


def _notify_feedback(db, pid: str, actor: User | None, title: str, text: str) -> None:
    """Opt-in-Benachrichtigung `feedback_new` an die Projekt-Owner (ohne Auslöser); Fehler verhindern nie das Speichern."""
    try:
        owners = [(m.subject_type, m.subject_id) for m in db.scalars(
            select(ProjectMember).where(ProjectMember.project_id == pid, ProjectMember.role == "owner"))]
        notify.send(db, notify.subject_user_ids(db, owners), "feedback_new", actor=actor, title=title, text=text,
                    project_id=pid)
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        log.exception("Feedback-Benachrichtigung fehlgeschlagen")


def _notify_doc_mentions(db, pid: str, doc: ProjectDoc, actor: User, mentions: list[dict], text: str) -> None:
    """Opt-in-Benachrichtigung `doc_mention`: Erwähnte mit Projektzugriff; Missionsbau-Dateien nur an Missionsbauer."""
    try:
        rec = mentions_svc.mention_recipients(db, pid, mentions, exclude=actor.id)
        if rec and doc.space == "builder":
            rec = {u.id for u in db.scalars(select(User).where(User.id.in_(rec))) if effective_mission_builder(db, u)}
        notify.send(db, rec, "doc_mention", actor=actor, title=doc.name, text=text, project_id=pid, plan_id=doc.id)
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        log.exception("Datei-Erwähnung: Benachrichtigung fehlgeschlagen")


def _feedback_count(db, pid: str) -> int:
    return db.scalar(select(func.count(ProjectFeedback.id)).where(ProjectFeedback.project_id == pid)) or 0


@router.get("/{pid}/feedback")
def list_feedback(
    pid: str, user: CurrentUser, db: DbDep,
    status_: Annotated[str | None, Query(alias="status", pattern=r"^(new|doing|done|rejected)$")] = None,
    kind: Annotated[str | None, Query(pattern=r"^(bug|idea|praise|other)$")] = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
    limit: Annotated[int, Query(ge=1, le=_MAX_FEEDBACK)] = 500,
) -> list[dict]:
    """Neueste zuerst; ``q`` sucht in Titel, Text und Absendername."""
    _ctx(db, user, pid)
    sel = select(ProjectFeedback).where(ProjectFeedback.project_id == pid)
    if status_:
        sel = sel.where(ProjectFeedback.status == status_)
    if kind:
        sel = sel.where(ProjectFeedback.kind == kind)
    if q and q.strip():
        pat = like_pattern(q.strip())
        sel = sel.where(ProjectFeedback.title.ilike(pat, escape="\\") | ProjectFeedback.text.ilike(pat, escape="\\")
                        | ProjectFeedback.author_name.ilike(pat, escape="\\"))
    rows = list(db.scalars(sel.order_by(ProjectFeedback.created_at.desc()).limit(limit)))
    return _feedback_out(db, user, rows)


@router.post("/{pid}/feedback", status_code=status.HTTP_201_CREATED)
def create_feedback(pid: str, body: FeedbackIn, user: CurrentUser, db: DbDep) -> dict:
    _ctx(db, user, pid, "viewer", write=True)  # auch Betrachter dürfen Rückmeldung geben
    title = body.title.strip()
    if not title:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Titel fehlt")
    if _feedback_count(db, pid) >= _MAX_FEEDBACK:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Zu viel Feedback im Projekt")
    _validate_task_refs(db, user, pid, {"plan_id": body.plan_id, "doc_id": body.doc_id})  # nur sichtbare Bezüge
    f = ProjectFeedback(
        project_id=pid, title=title, text=body.text.strip(), kind=body.kind, source="internal",
        author_name=user.label[:80], author_user_id=user.id, plan_id=body.plan_id or None, doc_id=body.doc_id or None,
    )
    db.add(f)
    db.commit()
    out = _feedback_out(db, user, [f])[0]
    _notify_feedback(db, pid, user, title, f.text)
    return out


@router.patch("/{pid}/feedback/{fid}")
def patch_feedback(pid: str, fid: str, body: FeedbackPatchIn, user: CurrentUser, db: DbDep) -> dict:
    _ctx(db, user, pid, "editor", write=True)
    f = _get_feedback(db, pid, fid)
    if body.status is not None and body.status != f.status:
        f.status = body.status
        f.handled_by = None if body.status == "new" else user.id
    if body.kind is not None:
        f.kind = body.kind
    if body.note is not None:
        f.note = body.note.strip()
    f.updated_at = now()
    db.commit()
    return _feedback_out(db, user, [f])[0]


@router.delete("/{pid}/feedback/{fid}")
def delete_feedback(pid: str, fid: str, user: CurrentUser, db: DbDep) -> dict:
    _ctx(db, user, pid, "owner", write=True)
    db.delete(_get_feedback(db, pid, fid))
    db.commit()
    return {"ok": True}


@router.post("/{pid}/feedback/{fid}/to-task", status_code=status.HTTP_201_CREATED)
def feedback_to_task(pid: str, fid: str, user: CurrentUser, db: DbDep) -> dict:
    """Erzeugt aus dem Feedback eine Aufgabe (Bezug auf Plan/Datei, soweit sichtbar) und setzt ``task_id``;
    ein neues Feedback wechselt dabei auf „in Arbeit“."""
    _ctx(db, user, pid, "editor", write=True)
    f = _get_feedback(db, pid, fid)
    if f.task_id and db.get(ProjectTask, f.task_id) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Zu diesem Feedback gibt es bereits eine Aufgabe")
    if db.scalar(select(func.count(ProjectTask.id)).where(ProjectTask.project_id == pid)) >= _MAX_TASKS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Zu viele Aufgaben")
    shown = _feedback_out(db, user, [f])[0]  # nur sichtbare Bezüge übernehmen
    who = f.author_name or "unbekannt"
    desc = f"{f.text}\n\n— Feedback ({f.kind}) von {who}".strip()[:20000]
    nxt = db.scalar(select(func.coalesce(func.max(ProjectTask.ordering), -1)).where(
        ProjectTask.project_id == pid, ProjectTask.status == "open"))
    t = ProjectTask(project_id=pid, title=f.title[:200], description=desc, plan_id=shown["plan_id"],
                    doc_id=shown["doc_id"], ordering=int(nxt) + 1, created_by=user.id, updated_by=user.id)
    _set_status(t, "open")
    db.add(t)
    db.flush()
    f.task_id = t.id
    if f.status == "new":
        f.status = "doing"
        f.handled_by = user.id
    f.updated_at = now()
    _act(db, user, pid, "task.create", "task", t.id, t.title, status=t.status, assignee_id=None)
    refs_svc.rebuild(db, pid, "task", t.id, t.title, t.description)
    db.commit()
    return {"feedback": _feedback_out(db, user, [f])[0], "task": _tasks_out(db, user, [t])[0]}


# ─── Feedback-Token (Owner) ────────────────────────────────────────────────

def _token_out(p: Project) -> dict:
    return {"enabled": bool(p.feedback_token), "token": p.feedback_token, "path": (
        f"/api/public/feedback/{p.feedback_token}" if p.feedback_token else None)}


@router.get("/{pid}/feedback-token")
def get_feedback_token(pid: str, user: CurrentUser, db: DbDep) -> dict:
    p, _ = _ctx(db, user, pid, "owner")
    return _token_out(p)


@router.post("/{pid}/feedback-token")
def rotate_feedback_token(pid: str, request: Request, user: CurrentUser, db: DbDep) -> dict:
    """Schaltet die Schnittstelle ein bzw. erzeugt ein neues Token (das alte wird sofort ungültig)."""
    p, _ = _ctx(db, user, pid, "owner", write=True)
    p.feedback_token = secrets.token_urlsafe(30)  # 40 Zeichen
    db.commit()
    _audit(db, request, user, "project.feedback_token.rotate", "project", pid)
    return _token_out(p)


@router.delete("/{pid}/feedback-token")
def disable_feedback_token(pid: str, request: Request, user: CurrentUser, db: DbDep) -> dict:
    p, _ = _ctx(db, user, pid, "owner")
    p.feedback_token = None
    db.commit()
    _audit(db, request, user, "project.feedback_token.disable", "project", pid)
    return _token_out(p)


# ─── Öffentliche Schnittstelle (ohne Login) ────────────────────────────────

class PublicFeedbackIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    text: str = Field(default="", max_length=5000)
    kind: Kind = "other"
    name: str = Field(default="", max_length=80)
    website: str = Field(default="", max_length=2000)  # Honeypot: Menschen lassen es leer


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _public_project(db, token: str) -> Project:
    """Projekt zum Token; unbekannt/aus -> 404, archiviert -> 410. Gibt nichts Weiteres preis."""
    p = db.scalar(select(Project).where(Project.feedback_token == token)) if _TOKEN_RE.match(token) else None
    if p is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nicht gefunden")
    if p.archived:
        raise HTTPException(status.HTTP_410_GONE, "Projekt nicht mehr aktiv")
    return p


@public_router.get("/{token}")
def public_feedback_info(token: str, request: Request, db: DbDep) -> dict:
    if not hit_limit(f"fbget:{_client_ip(request)}", *_PUB_IP_GET):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Zu viele Anfragen")
    p = _public_project(db, token)
    return {"project": p.name, "kinds": list(KINDS)}


@public_router.post("/{token}", status_code=status.HTTP_201_CREATED)
def public_feedback_submit(token: str, body: PublicFeedbackIn, request: Request, db: DbDep) -> dict:
    ip = _client_ip(request)
    if not hit_limit(f"fbip:{ip}", *_PUB_IP_POST):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Zu viele Anfragen")
    p = _public_project(db, token)
    if not hit_limit(f"fbtok:{p.id}", *_PUB_TOKEN_POST):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Zu viele Anfragen")
    if body.website.strip():
        return {"ok": True}  # Honeypot: Bot -> scheinbar angenommen, aber verworfen
    title = body.title.strip()
    if not title:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Titel fehlt")
    if _feedback_count(db, p.id) >= _MAX_FEEDBACK:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Das Postfach ist voll")
    db.add(ProjectFeedback(
        project_id=p.id, title=title, text=body.text.strip(), kind=body.kind, source="external",
        author_name=body.name.strip(),
    ))
    db.commit()
    _notify_feedback(db, p.id, None, title, body.text.strip())
    return {"ok": True}


# ─── Meilensteine ──────────────────────────────────────────────────────────

class MilestoneIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    due_date: date | None = None


class MilestonePatchIn(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    due_date: date | None = None  # nur wirksam, wenn im Body enthalten (null = Termin entfernen)
    done: bool | None = None
    ordering: int | None = Field(default=None, ge=0, le=100000)


def _milestone_out(m: ProjectMilestone) -> dict:
    return {"id": m.id, "title": m.title, "due_date": m.due_date.isoformat() if m.due_date else None,
            "done": bool(m.done), "ordering": m.ordering}


def _get_milestone(db, pid: str, mid: str) -> ProjectMilestone:
    m = db.get(ProjectMilestone, mid)
    if m is None or m.project_id != pid:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meilenstein nicht gefunden")
    return m


@router.get("/{pid}/milestones")
def list_milestones(pid: str, user: CurrentUser, db: DbDep) -> list[dict]:
    """Nach ``ordering``, bei Gleichstand nach Termin (ohne Termin zuletzt)."""
    _ctx(db, user, pid)
    rows = list(db.scalars(select(ProjectMilestone).where(ProjectMilestone.project_id == pid)))
    rows.sort(key=lambda m: (m.ordering, m.due_date is None, m.due_date or date.max, m.title.lower()))
    return [_milestone_out(m) for m in rows]


@router.post("/{pid}/milestones", status_code=status.HTTP_201_CREATED)
def create_milestone(pid: str, body: MilestoneIn, user: CurrentUser, db: DbDep) -> dict:
    _ctx(db, user, pid, "editor", write=True)
    title = body.title.strip()
    if not title:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Titel fehlt")
    if db.scalar(select(func.count(ProjectMilestone.id)).where(ProjectMilestone.project_id == pid)) >= _MAX_MILESTONES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Zu viele Meilensteine")
    nxt = db.scalar(select(func.coalesce(func.max(ProjectMilestone.ordering), -1)).where(
        ProjectMilestone.project_id == pid))
    m = ProjectMilestone(project_id=pid, title=title, due_date=body.due_date, ordering=int(nxt) + 1)
    db.add(m)
    db.commit()
    return _milestone_out(m)


@router.patch("/{pid}/milestones/{mid}")
def patch_milestone(pid: str, mid: str, body: MilestonePatchIn, user: CurrentUser, db: DbDep) -> dict:
    _ctx(db, user, pid, "editor", write=True)
    m = _get_milestone(db, pid, mid)
    if body.title is not None:
        if not body.title.strip():
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Titel fehlt")
        m.title = body.title.strip()
    if "due_date" in body.model_fields_set:
        m.due_date = body.due_date
    if body.done is not None:
        m.done = body.done
    if body.ordering is not None:
        m.ordering = body.ordering
    db.commit()
    return _milestone_out(m)


@router.delete("/{pid}/milestones/{mid}")
def delete_milestone(pid: str, mid: str, user: CurrentUser, db: DbDep) -> dict:
    _ctx(db, user, pid, "editor", write=True)
    db.delete(_get_milestone(db, pid, mid))
    db.commit()
    return {"ok": True}


# ─── Dokument-Kommentare ───────────────────────────────────────────────────

def _get_text_doc(db, user: User, pid: str, doc_id: str) -> ProjectDoc:
    """Datei mit Missionsbau-Prüfung (404 für Nicht-Missionsbauer); Ordner haben weder Kommentare noch Versionen."""
    d = _get_doc(db, user, pid, doc_id)
    if d.kind != "doc":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nur für Dateien, nicht für Ordner")
    return d


def _dcomment_out(c: DocComment, labels: dict[str, str], user: User, role: str) -> dict:
    return {
        "id": c.id, "doc_id": c.doc_id, "user_id": c.user_id, "user_label": labels.get(c.user_id or "", None),
        "text": c.text, "mentions": c.mentions or [], "created_at": _iso(c.created_at), "edited_at": _iso(c.edited_at),
        "can_edit": c.user_id == user.id, "can_delete": c.user_id == user.id or rank(role) >= rank("owner"),
    }


def _dcomments_out(db, cs: list[DocComment], user: User, role: str) -> list[dict]:
    labels = _labels(db, [c.user_id for c in cs])
    return [_dcomment_out(c, labels, user, role) for c in cs]


def _get_dcomment(db, pid: str, doc_id: str, cid: str) -> DocComment:
    c = db.get(DocComment, cid)
    if c is None or c.project_id != pid or c.doc_id != doc_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Kommentar nicht gefunden")
    return c


@router.get("/{pid}/docs/{doc_id}/comments")
def list_doc_comments(pid: str, doc_id: str, user: CurrentUser, db: DbDep) -> list[dict]:
    _, role = _ctx(db, user, pid)
    _get_text_doc(db, user, pid, doc_id)
    cs = list(db.scalars(select(DocComment).where(DocComment.doc_id == doc_id).order_by(DocComment.created_at)))
    return _dcomments_out(db, cs, user, role)


@router.post("/{pid}/docs/{doc_id}/comments", status_code=status.HTTP_201_CREATED)
def create_doc_comment(pid: str, doc_id: str, body: CommentIn, user: CurrentUser, db: DbDep) -> dict:
    _, role = _ctx(db, user, pid, "viewer", write=True)  # auch Betrachter dürfen kommentieren
    doc = _get_text_doc(db, user, pid, doc_id)
    text = body.text.strip()
    if not text:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Text fehlt")
    if db.scalar(select(func.count(DocComment.id)).where(DocComment.doc_id == doc_id)) >= _MAX_COMMENTS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Zu viele Kommentare")
    c = DocComment(project_id=pid, doc_id=doc_id, user_id=user.id, text=text,
                   mentions=mentions_svc.resolve_mentions(db, text, pid))
    db.add(c)
    db.commit()
    out = _dcomments_out(db, [c], user, role)[0]
    _notify_doc_mentions(db, pid, doc, user, c.mentions or [], text)
    return out


@router.patch("/{pid}/docs/{doc_id}/comments/{cid}")
def patch_doc_comment(pid: str, doc_id: str, cid: str, body: CommentIn, user: CurrentUser, db: DbDep) -> dict:
    _, role = _ctx(db, user, pid, "viewer", write=True)
    doc = _get_text_doc(db, user, pid, doc_id)
    c = _get_dcomment(db, pid, doc_id, cid)
    if c.user_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Nur eigene Kommentare bearbeitbar")
    text = body.text.strip()
    if not text:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Text fehlt")
    added: list[dict] = []
    if text != c.text:
        old = {(m["type"], m["id"]) for m in (c.mentions or [])}
        c.text = text
        c.mentions = mentions_svc.resolve_mentions(db, text, pid)
        c.edited_at = now()
        added = [m for m in c.mentions if (m["type"], m["id"]) not in old]  # nur neu Erwähnte
    db.commit()
    out = _dcomments_out(db, [c], user, role)[0]
    if added:
        _notify_doc_mentions(db, pid, doc, user, added, text)
    return out


@router.delete("/{pid}/docs/{doc_id}/comments/{cid}")
def delete_doc_comment(pid: str, doc_id: str, cid: str, user: CurrentUser, db: DbDep) -> dict:
    _, role = _ctx(db, user, pid, "viewer", write=True)
    _get_text_doc(db, user, pid, doc_id)
    c = _get_dcomment(db, pid, doc_id, cid)
    if c.user_id != user.id and rank(role) < rank("owner"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Nur eigene Kommentare löschbar")
    db.delete(c)
    db.commit()
    return {"ok": True}


# ─── Dokument-Versionen ────────────────────────────────────────────────────

def _version_out(v: ProjectDocVersion, labels: dict[str, str], content: bool = False) -> dict:
    out = {"id": v.id, "doc_id": v.doc_id, "name": v.name, "saved_by": v.saved_by,
           "saved_by_label": labels.get(v.saved_by or "", None), "created_at": _iso(v.created_at),
           "byte_size": len((v.content or "").encode("utf-8"))}
    if content:
        out["content"] = v.content
    return out


def _get_version(db, doc_id: str, vid: str) -> ProjectDocVersion:
    v = db.get(ProjectDocVersion, vid)
    if v is None or v.doc_id != doc_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Version nicht gefunden")
    return v


@router.get("/{pid}/docs/{doc_id}/versions")
def list_doc_versions(pid: str, doc_id: str, user: CurrentUser, db: DbDep) -> list[dict]:
    """Gesicherte frühere Stände (ohne Inhalt), neueste zuerst."""
    _ctx(db, user, pid)
    _get_text_doc(db, user, pid, doc_id)
    vs = list(db.scalars(select(ProjectDocVersion).where(ProjectDocVersion.doc_id == doc_id)
                         .order_by(ProjectDocVersion.created_at.desc())))
    labels = _labels(db, [v.saved_by for v in vs])
    return [_version_out(v, labels) for v in vs]


@router.get("/{pid}/docs/{doc_id}/versions/{vid}")
def get_doc_version(pid: str, doc_id: str, vid: str, user: CurrentUser, db: DbDep) -> dict:
    _ctx(db, user, pid)
    _get_text_doc(db, user, pid, doc_id)
    v = _get_version(db, doc_id, vid)
    return _version_out(v, _labels(db, [v.saved_by]), content=True)


@router.post("/{pid}/docs/{doc_id}/versions/{vid}/restore")
def restore_doc_version(pid: str, doc_id: str, vid: str, request: Request, user: CurrentUser, db: DbDep) -> dict:
    """Setzt den Inhalt der Datei auf die Version zurück; der aktuelle Stand wird vorher als Version gesichert.
    Der Dateiname bleibt unverändert. Antwort wie ``GET …/docs/{id}``."""
    _ctx(db, user, pid, "editor", write=True)
    d = _get_text_doc(db, user, pid, doc_id)
    v = _get_version(db, doc_id, vid)
    if d.content != v.content:
        versions_svc.snapshot(db, d, d.name, d.content, user.id, force=True)
        d.content = v.content
        d.byte_size = len(v.content.encode("utf-8"))
        d.updated_by = user.id
        d.updated_at = now()
        _act(db, user, pid, "doc.update", "doc", d.id, d.name, space=d.space)
        refs_svc.rebuild(db, pid, "doc", d.id, d.content)
        timeline_svc.rebuild(db, d)
        db.commit()
        _audit(db, request, user, "project.doc.restore", "project_doc", d.id, project_id=pid, version=vid)
    return _doc_out(d, _labels(db, [user.id]), content=True)
