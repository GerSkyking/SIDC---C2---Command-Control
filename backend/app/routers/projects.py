"""Missionsbau-Projekte: Projekte, Mitglieder, Dateien (Öffentlich/Missionsbau), Bilder,
Haftnotizen, Aufgaben, Übersicht. Spezifikation: docs/PROJEKTE.md.

Rechte: Projektrolle viewer < editor < owner (Admin = owner). Der Bereich „Missionsbau“
(space == "builder") ist für Nicht-Missionsbauer weder sichtbar noch erreichbar (404).
Alle Endpunkte sind plain ``def`` (laufen im Threadpool).
"""
from __future__ import annotations

import math
from datetime import date, datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from .. import audit
from ..deps import CurrentUser, DbDep
from ..models import (
    Group,
    GroupMember,
    ImagePlacement,
    Phase,
    Plan,
    PlanFolder,
    PlanImage,
    Project,
    ProjectDoc,
    ProjectMember,
    ProjectNote,
    ProjectTask,
    User,
    now,
)
from ..permissions import effective_level, effective_mission_builder, project_role, rank
from ..schemas import (
    DocCreateIn,
    DocPatchIn,
    ImagePatchIn,
    NoteCreateIn,
    NotePatchIn,
    PlanListItem,
    PlanOut,
    ProjectCreateIn,
    ProjectMemberIn,
    ProjectPatchIn,
    TaskCreateIn,
    TaskMoveIn,
    TaskPatchIn,
)
from ..services.realtime import broadcast_from_thread
from .live import _author_of, _image_out
from .project_folders import can_use_folder

router = APIRouter(prefix="/projects", tags=["projects"])

_MAX_DOCS = 5000
_MAX_NOTES = 500
_MAX_TASKS = 5000
_MAX_MEMBERS = 500
_SPACE_Q = Annotated[str, Query(pattern=r"^(public|builder)$")]


# ─── Helfer ────────────────────────────────────────────────────────────────

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
    if not ids:
        return {}
    return {u.id: u.label for u in db.scalars(select(User).where(User.id.in_(ids)))}


def _ctx(db: Session, user: User, pid: str, need: str = "viewer", write: bool = False) -> tuple[Project, str]:
    """Projekt + Rolle des Nutzers. 404 ohne Zugriff, 403 bei zu niedriger Rolle,
    403 bei Schreibzugriff auf ein archiviertes Projekt."""
    proj = db.get(Project, pid)
    role = project_role(db, user, pid) if proj else None
    if proj is None or role is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Projekt nicht gefunden")
    if rank(role) < rank(need):
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"Projekt-Recht '{need}' erforderlich")
    if write and proj.archived:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Projekt ist archiviert")
    return proj, role


def _require_space(db: Session, user: User, space: str) -> None:
    if space == "builder" and not effective_mission_builder(db, user):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nicht gefunden")


def _get_doc(db: Session, user: User, pid: str, doc_id: str) -> ProjectDoc:
    d = db.get(ProjectDoc, doc_id)
    if d is None or d.project_id != pid:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dokument nicht gefunden")
    _require_space(db, user, d.space)
    return d


def _audit(db, request, user, action, ttype, tid, **detail):
    audit.record(db, action, user_id=user.id, target_type=ttype, target_id=tid, request=request, **detail)


def _project_out(db: Session, p: Project, role: str, user: User) -> dict:
    return {
        "id": p.id, "name": p.name, "description": p.description, "archived": bool(p.archived),
        "role": role, "is_builder": effective_mission_builder(db, user), "folder_id": p.folder_id,
        "created_by": p.created_by, "created_at": _iso(p.created_at), "updated_at": _iso(p.updated_at),
    }


# ─── Projekte ──────────────────────────────────────────────────────────────

@router.get("")
def list_projects(user: CurrentUser, db: DbDep) -> list[dict]:
    projects = list(db.scalars(select(Project).order_by(Project.updated_at.desc())))
    roles: dict[str, str] = {}
    if user.is_admin:
        roles = {p.id: "owner" for p in projects}
    else:
        gids = list(db.scalars(select(GroupMember.group_id).where(GroupMember.user_id == user.id)))
        subj = {("user", user.id), *(("group", g) for g in gids)}
        for m in db.scalars(select(ProjectMember)):
            if (m.subject_type, m.subject_id) in subj and rank(m.role) > rank(roles.get(m.project_id)):
                roles[m.project_id] = m.role
    plan_cnt: dict[str, int] = {}  # nur Pläne, die der Nutzer per Plan-ACL sehen darf
    if roles:
        for pl in db.scalars(select(Plan).where(Plan.project_id.in_(list(roles)), Plan.deleted_at.is_(None))):
            if effective_level(db, user, pl) is not None:
                plan_cnt[pl.project_id] = plan_cnt.get(pl.project_id, 0) + 1
    open_cnt = dict(db.execute(
        select(ProjectTask.project_id, func.count(ProjectTask.id))
        .where(ProjectTask.status != "done").group_by(ProjectTask.project_id)
    ).all())
    mine_cnt = dict(db.execute(
        select(ProjectTask.project_id, func.count(ProjectTask.id))
        .where(ProjectTask.status != "done", ProjectTask.assignee_id == user.id)
        .group_by(ProjectTask.project_id)
    ).all())
    return [
        {
            "id": p.id, "name": p.name, "description": p.description, "archived": bool(p.archived),
            "role": roles[p.id], "folder_id": p.folder_id, "plan_count": int(plan_cnt.get(p.id, 0)),
            "open_tasks": int(open_cnt.get(p.id, 0)), "my_open_tasks": int(mine_cnt.get(p.id, 0)),
            "updated_at": _iso(p.updated_at),
        }
        for p in projects if p.id in roles
    ]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_project(body: ProjectCreateIn, request: Request, user: CurrentUser, db: DbDep) -> dict:
    if not effective_mission_builder(db, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Nur Missionsbauer dürfen Projekte anlegen")
    name = body.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Name fehlt")
    if body.folder_id is not None and not can_use_folder(db, user, body.folder_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ordner nicht gefunden")
    p = Project(name=name, description=body.description, created_by=user.id, folder_id=body.folder_id)
    db.add(p)
    db.flush()
    db.add(ProjectMember(project_id=p.id, subject_type="user", subject_id=user.id, role="owner"))
    db.commit()
    _audit(db, request, user, "project.create", "project", p.id, name=p.name)
    return _project_out(db, p, "owner", user)


@router.get("/{pid}")
def get_project(pid: str, user: CurrentUser, db: DbDep) -> dict:
    p, role = _ctx(db, user, pid)
    return _project_out(db, p, role, user)


@router.patch("/{pid}")
def patch_project(pid: str, body: ProjectPatchIn, request: Request, user: CurrentUser, db: DbDep) -> dict:
    p, role = _ctx(db, user, pid, "owner")
    if body.name is not None:
        if not body.name.strip():
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Name fehlt")
        p.name = body.name.strip()
    if body.description is not None:
        p.description = body.description
    if body.archived is not None:
        p.archived = body.archived
    if "folder_id" in body.model_fields_set and body.folder_id != p.folder_id:
        if body.folder_id is not None and not can_use_folder(db, user, body.folder_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Ordner nicht gefunden")
        p.folder_id = body.folder_id
    p.updated_at = now()
    db.commit()
    _audit(db, request, user, "project.update", "project", p.id, name=p.name, archived=p.archived)
    return _project_out(db, p, role, user)


@router.delete("/{pid}")
def delete_project(pid: str, request: Request, user: CurrentUser, db: DbDep) -> dict:
    p, _ = _ctx(db, user, pid, "owner")
    name = p.name
    # Explizit (SQLite erzwingt FKs nicht): Pläne bleiben erhalten, nur die Zuordnung entfällt.
    folder_ids = list(db.scalars(select(PlanFolder.id).where(PlanFolder.project_id == pid)))
    if folder_ids:
        db.execute(update(Plan).where(Plan.folder_id.in_(folder_ids)).values(folder_id=None))
    db.execute(update(Plan).where(Plan.project_id == pid).values(project_id=None))
    db.execute(update(PlanImage).where(PlanImage.project_id == pid).values(project_id=None))
    db.execute(sa_delete(PlanFolder).where(PlanFolder.project_id == pid))
    db.execute(sa_delete(ProjectTask).where(ProjectTask.project_id == pid))
    db.execute(sa_delete(ProjectNote).where(ProjectNote.project_id == pid))
    db.execute(sa_delete(ProjectDoc).where(ProjectDoc.project_id == pid))
    db.execute(sa_delete(ProjectMember).where(ProjectMember.project_id == pid))
    db.delete(p)
    db.commit()
    _audit(db, request, user, "project.delete", "project", pid, name=name)
    return {"ok": True}


# ─── Mitglieder ────────────────────────────────────────────────────────────

def _member_rows(db: Session, pid: str) -> list[dict]:
    rows = list(db.scalars(select(ProjectMember).where(ProjectMember.project_id == pid)))
    users = {u.id: u for u in db.scalars(select(User).where(
        User.id.in_([r.subject_id for r in rows if r.subject_type == "user"])))}
    groups = {g.id: g for g in db.scalars(select(Group).where(
        Group.id.in_([r.subject_id for r in rows if r.subject_type == "group"])))}
    out = []
    for r in rows:
        if r.subject_type == "user":
            u = users.get(r.subject_id)
            name = (f"{u.display_name} ({u.username})" if u and u.display_name else u.username) if u else "—"
        else:
            g = groups.get(r.subject_id)
            name = f"Gruppe: {g.name}" if g else "—"
        out.append({"subject_type": r.subject_type, "subject_id": r.subject_id, "role": r.role, "name": name})
    out.sort(key=lambda x: (-rank(x["role"]), x["name"].lower()))
    return out


@router.get("/{pid}/members")
def get_members(pid: str, user: CurrentUser, db: DbDep) -> list[dict]:
    _ctx(db, user, pid)
    return _member_rows(db, pid)


@router.get("/{pid}/members/candidates")
def member_candidates(pid: str, user: CurrentUser, db: DbDep) -> list[dict]:
    _ctx(db, user, pid, "owner")
    out = [
        {"subject_type": "user", "subject_id": u.id,
         "name": f"{u.display_name} ({u.username})" if u.display_name else u.username}
        for u in db.scalars(select(User).where(User.is_active.is_(True)).order_by(User.username))
    ]
    out += [
        {"subject_type": "group", "subject_id": g.id, "name": f"Gruppe: {g.name}"}
        for g in db.scalars(select(Group).order_by(Group.name))
    ]
    return out


@router.put("/{pid}/members")
def put_members(
    pid: str, body: list[ProjectMemberIn], request: Request, user: CurrentUser, db: DbDep
) -> list[dict]:
    _ctx(db, user, pid, "owner", write=True)
    if len(body) > _MAX_MEMBERS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Zu viele Mitglieder")
    seen: set[tuple[str, str]] = set()
    for m in body:
        key = (m.subject_type, m.subject_id)
        if key in seen:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Doppelter Eintrag")
        seen.add(key)
        exists = db.get(User, m.subject_id) if m.subject_type == "user" else db.get(Group, m.subject_id)
        if exists is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unbekannter Nutzer/Gruppe")
    if not any(m.role == "owner" for m in body):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Mindestens ein Eigentümer (owner) nötig")
    db.execute(sa_delete(ProjectMember).where(ProjectMember.project_id == pid))
    for m in body:
        db.add(ProjectMember(project_id=pid, subject_type=m.subject_type, subject_id=m.subject_id, role=m.role))
    db.commit()
    _audit(db, request, user, "project.members", "project", pid, count=len(body))
    return _member_rows(db, pid)


@router.get("/{pid}/assignees")
def assignees(pid: str, user: CurrentUser, db: DbDep) -> list[dict]:
    """Aktive Nutzer mit Projektzugriff (direkt oder über Gruppe) – für die Aufgaben-Zuständigkeit."""
    _ctx(db, user, pid)
    ids: set[str] = set()
    for m in db.scalars(select(ProjectMember).where(ProjectMember.project_id == pid)):
        if m.subject_type == "user":
            ids.add(m.subject_id)
        else:
            ids.update(db.scalars(select(GroupMember.user_id).where(GroupMember.group_id == m.subject_id)))
    users = db.scalars(select(User).where(User.id.in_(ids), User.is_active.is_(True)))
    return sorted(({"user_id": u.id, "label": u.label} for u in users), key=lambda x: x["label"].lower())


# ─── Dateien (Öffentlich / Missionsbau) ────────────────────────────────────

def _doc_out(d: ProjectDoc, labels: dict[str, str], content: bool = False) -> dict:
    out = {
        "id": d.id, "parent_id": d.parent_id, "kind": d.kind, "name": d.name, "space": d.space,
        "ordering": d.ordering, "byte_size": d.byte_size, "updated_at": _iso(d.updated_at),
        "updated_by": labels.get(d.updated_by or "", None),
    }
    if content:
        out["content"] = d.content
        out["project_id"] = d.project_id
    return out


@router.get("/{pid}/docs")
def list_docs(pid: str, user: CurrentUser, db: DbDep, space: _SPACE_Q = "public") -> list[dict]:
    _ctx(db, user, pid)
    _require_space(db, user, space)
    rows = list(db.scalars(
        select(ProjectDoc).where(ProjectDoc.project_id == pid, ProjectDoc.space == space)
        .order_by(ProjectDoc.ordering, ProjectDoc.name)
    ))
    labels = _labels(db, [d.updated_by for d in rows])
    return [_doc_out(d, labels) for d in rows]


def _check_parent(db: Session, pid: str, space: str, parent_id: str | None) -> None:
    if parent_id is None:
        return
    par = db.get(ProjectDoc, parent_id)
    if par is None or par.project_id != pid or par.space != space or par.kind != "folder":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Zielordner nicht gefunden")


@router.post("/{pid}/docs", status_code=status.HTTP_201_CREATED)
def create_doc(pid: str, body: DocCreateIn, request: Request, user: CurrentUser, db: DbDep) -> dict:
    _ctx(db, user, pid, "editor", write=True)
    _require_space(db, user, body.space)
    name = body.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Name fehlt")
    if db.scalar(select(func.count(ProjectDoc.id)).where(ProjectDoc.project_id == pid)) >= _MAX_DOCS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Zu viele Dateien im Projekt")
    parent_id = body.parent_id or None
    _check_parent(db, pid, body.space, parent_id)
    content = body.content if body.kind == "doc" else ""
    nxt = db.scalar(select(func.coalesce(func.max(ProjectDoc.ordering), -1)).where(
        ProjectDoc.project_id == pid, ProjectDoc.space == body.space, ProjectDoc.parent_id == parent_id
        if parent_id else ProjectDoc.parent_id.is_(None)))
    d = ProjectDoc(
        project_id=pid, space=body.space, parent_id=parent_id, kind=body.kind, name=name,
        content=content, ordering=int(nxt) + 1, byte_size=len(content.encode("utf-8")),
        created_by=user.id, updated_by=user.id,
    )
    db.add(d)
    db.commit()
    _audit(db, request, user, "project.doc.create", "project_doc", d.id, project_id=pid, space=d.space)
    return _doc_out(d, _labels(db, [user.id]), content=True)


@router.get("/{pid}/docs/{doc_id}")
def get_doc(pid: str, doc_id: str, user: CurrentUser, db: DbDep) -> dict:
    _ctx(db, user, pid)
    d = _get_doc(db, user, pid, doc_id)
    return _doc_out(d, _labels(db, [d.updated_by]), content=True)


@router.patch("/{pid}/docs/{doc_id}")
def patch_doc(
    pid: str, doc_id: str, body: DocPatchIn, request: Request, user: CurrentUser, db: DbDep
) -> dict:
    _ctx(db, user, pid, "editor", write=True)
    d = _get_doc(db, user, pid, doc_id)
    if body.expected_updated_at is not None and d.updated_at is not None:
        if _naive(body.expected_updated_at) != _naive(d.updated_at):
            raise HTTPException(status.HTTP_409_CONFLICT, "Dokument wurde zwischenzeitlich geändert")
    if body.name is not None:
        if not body.name.strip():
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Name fehlt")
        d.name = body.name.strip()
    if body.content is not None:
        if d.kind != "doc":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ordner haben keinen Inhalt")
        d.content = body.content
        d.byte_size = len(body.content.encode("utf-8"))
    if "parent_id" in body.model_fields_set:
        target = body.parent_id or None
        _check_parent(db, pid, d.space, target)
        if target is not None:
            if target == d.id:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Zyklus im Dateibaum")
            seen: set[str] = set()
            cur: str | None = target
            while cur and cur not in seen:  # Vorfahren des Ziels dürfen d nicht enthalten
                if cur == d.id:
                    raise HTTPException(status.HTTP_400_BAD_REQUEST, "Zyklus im Dateibaum")
                seen.add(cur)
                anc = db.get(ProjectDoc, cur)
                cur = anc.parent_id if anc else None
        d.parent_id = target
    if body.ordering is not None:
        d.ordering = body.ordering
    d.updated_by = user.id
    d.updated_at = now()
    db.commit()
    _audit(db, request, user, "project.doc.update", "project_doc", d.id, project_id=pid)
    return _doc_out(d, _labels(db, [user.id]), content=True)


@router.delete("/{pid}/docs/{doc_id}")
def delete_doc(pid: str, doc_id: str, request: Request, user: CurrentUser, db: DbDep) -> dict:
    _ctx(db, user, pid, "editor", write=True)
    d = _get_doc(db, user, pid, doc_id)
    ids, frontier = {d.id}, [d.id]
    while frontier:
        kids = list(db.scalars(select(ProjectDoc.id).where(
            ProjectDoc.project_id == pid, ProjectDoc.parent_id.in_(frontier))))
        frontier = [k for k in kids if k not in ids]
        ids.update(frontier)
    db.execute(update(ProjectTask).where(ProjectTask.doc_id.in_(ids)).values(doc_id=None))
    db.execute(sa_delete(ProjectDoc).where(ProjectDoc.id.in_(ids)))
    db.commit()
    _audit(db, request, user, "project.doc.delete", "project_doc", doc_id, project_id=pid, count=len(ids))
    return {"ok": True}


# ─── Bilder ────────────────────────────────────────────────────────────────

def _image_spaces(db: Session, imgs: list[PlanImage]) -> dict[str, str]:
    """image.id -> 'builder' | 'public' (Phase.plane == 'builder')."""
    pids = {i.phase_id for i in imgs if i.phase_id}
    planes = dict(db.execute(select(Phase.id, Phase.plane).where(Phase.id.in_(pids))).all()) if pids else {}
    return {i.id: ("builder" if planes.get(i.phase_id or "") == "builder" else "public") for i in imgs}


def _project_image(db: Session, user: User, pid: str, image_id: str) -> tuple[PlanImage, str]:
    i = db.get(PlanImage, image_id)
    if i is None or i.project_id != pid:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bild nicht gefunden")
    space = _image_spaces(db, [i])[i.id]
    _require_space(db, user, space)
    return i, space


@router.get("/{pid}/images")
def list_project_images(pid: str, user: CurrentUser, db: DbDep, space: _SPACE_Q = "public") -> list[dict]:
    _ctx(db, user, pid)
    _require_space(db, user, space)
    rows = list(db.scalars(
        select(PlanImage).join(Plan, Plan.id == PlanImage.plan_id)
        .where(PlanImage.project_id == pid, Plan.deleted_at.is_(None))
        .order_by(PlanImage.created_at.desc())
    ))
    spaces = _image_spaces(db, rows)
    rows = [i for i in rows if spaces[i.id] == space]
    plan_names = {p.id: p.name for p in db.scalars(select(Plan).where(Plan.id.in_({i.plan_id for i in rows})))} if rows else {}
    authors = _labels(db, [i.created_by for i in rows])
    return [
        {
            "id": i.id, "plan_id": i.plan_id, "plan_name": plan_names.get(i.plan_id, "—"),
            "filename": i.filename, "caption": i.caption, "note": i.note, "byte_size": i.byte_size,
            "natural_w": i.natural_w, "natural_h": i.natural_h, "phase_id": i.phase_id, "space": space,
            "created_at": _iso(i.created_at), "author": authors.get(i.created_by or "", None),
        }
        for i in rows
    ]


@router.patch("/{pid}/images/{image_id}")
def patch_project_image(
    pid: str, image_id: str, body: ImagePatchIn, request: Request, user: CurrentUser, db: DbDep
) -> dict:
    _ctx(db, user, pid, "editor", write=True)
    i, space = _project_image(db, user, pid, image_id)
    if body.caption is not None:
        i.caption = body.caption
    if body.note is not None:
        i.note = body.note
    i.updated_by = user.id
    i.updated_at = now()
    db.commit()
    out = _image_out(i, _author_of(db, i))
    broadcast_from_thread(i.plan_id, {"type": "image.upsert", "image": out}, builder_only=space == "builder")
    _audit(db, request, user, "project.image.update", "image", i.id, project_id=pid)
    return out


@router.delete("/{pid}/images/{image_id}")
def delete_project_image(pid: str, image_id: str, request: Request, user: CurrentUser, db: DbDep) -> dict:
    _ctx(db, user, pid, "editor", write=True)
    i, space = _project_image(db, user, pid, image_id)
    plan_id = i.plan_id
    db.execute(sa_delete(ImagePlacement).where(ImagePlacement.image_id == i.id))
    db.delete(i)
    db.commit()
    broadcast_from_thread(plan_id, {"type": "image.delete", "id": image_id}, builder_only=space == "builder")
    _audit(db, request, user, "project.image.delete", "image", image_id, project_id=pid)
    return {"ok": True}


# ─── Whiteboard-Notizen ────────────────────────────────────────────────────

def _fin(v: float, lo: float, hi: float) -> float:
    if not math.isfinite(v):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ungültige Zahl")
    return max(lo, min(hi, v))


def _note_out(n: ProjectNote) -> dict:
    return {
        "id": n.id, "text": n.text, "color": n.color, "x": n.x, "y": n.y, "w": n.w, "h": n.h,
        "updated_at": _iso(n.updated_at), "created_by": n.created_by, "updated_by": n.updated_by,
    }


def _get_note(db: Session, pid: str, nid: str) -> ProjectNote:
    n = db.get(ProjectNote, nid)
    if n is None or n.project_id != pid:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Notiz nicht gefunden")
    return n


@router.get("/{pid}/notes")
def list_notes(pid: str, user: CurrentUser, db: DbDep) -> list[dict]:
    _ctx(db, user, pid)
    return [_note_out(n) for n in db.scalars(
        select(ProjectNote).where(ProjectNote.project_id == pid).order_by(ProjectNote.created_at))]


@router.post("/{pid}/notes", status_code=status.HTTP_201_CREATED)
def create_note(pid: str, body: NoteCreateIn, user: CurrentUser, db: DbDep) -> dict:
    _ctx(db, user, pid, "editor", write=True)
    if db.scalar(select(func.count(ProjectNote.id)).where(ProjectNote.project_id == pid)) >= _MAX_NOTES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Zu viele Notizen")
    n = ProjectNote(
        project_id=pid, text=body.text, color=body.color,
        x=_fin(body.x, -100000, 100000), y=_fin(body.y, -100000, 100000),
        w=_fin(body.w, 80, 2000), h=_fin(body.h, 60, 2000),
        created_by=user.id, updated_by=user.id,
    )
    db.add(n)
    db.commit()
    return _note_out(n)


@router.patch("/{pid}/notes/{nid}")
def patch_note(pid: str, nid: str, body: NotePatchIn, user: CurrentUser, db: DbDep) -> dict:
    _ctx(db, user, pid, "editor", write=True)
    n = _get_note(db, pid, nid)
    if body.text is not None:
        n.text = body.text
    if body.color is not None:
        n.color = body.color
    if body.x is not None:
        n.x = _fin(body.x, -100000, 100000)
    if body.y is not None:
        n.y = _fin(body.y, -100000, 100000)
    if body.w is not None:
        n.w = _fin(body.w, 80, 2000)
    if body.h is not None:
        n.h = _fin(body.h, 60, 2000)
    n.updated_by = user.id
    n.updated_at = now()
    db.commit()
    return _note_out(n)


@router.delete("/{pid}/notes/{nid}")
def delete_note(pid: str, nid: str, user: CurrentUser, db: DbDep) -> dict:
    _ctx(db, user, pid, "editor", write=True)
    db.delete(_get_note(db, pid, nid))
    db.commit()
    return {"ok": True}


# ─── Aufgaben ──────────────────────────────────────────────────────────────

def _task_out(t: ProjectTask, labels: dict, plan_names: dict, doc_names: dict, is_builder: bool) -> dict:
    doc = doc_names.get(t.doc_id or "")
    return {
        "id": t.id, "title": t.title, "description": t.description, "status": t.status,
        "priority": t.priority, "assignee_id": t.assignee_id,
        "assignee_label": labels.get(t.assignee_id or "", None),
        "due_date": t.due_date.isoformat() if t.due_date else None, "ordering": t.ordering,
        "plan_id": t.plan_id, "plan_name": plan_names.get(t.plan_id or "", None),
        "doc_id": t.doc_id,
        # Titel von Missionsbau-Dokumenten für Nicht-Missionsbauer ausgeblendet
        "doc_name": (doc[0] if doc and (is_builder or doc[1] != "builder") else None),
        "created_at": _iso(t.created_at), "updated_at": _iso(t.updated_at), "done_at": _iso(t.done_at),
    }


def _tasks_out(db: Session, user: User, tasks: list[ProjectTask]) -> list[dict]:
    labels = _labels(db, [t.assignee_id for t in tasks])
    pl = {i for t in tasks if (i := t.plan_id)}
    dc = {i for t in tasks if (i := t.doc_id)}
    plan_names = {p.id: p.name for p in db.scalars(select(Plan).where(Plan.id.in_(pl)))} if pl else {}
    doc_names = {d.id: (d.name, d.space) for d in db.scalars(select(ProjectDoc).where(ProjectDoc.id.in_(dc)))} if dc else {}
    b = effective_mission_builder(db, user)
    return [_task_out(t, labels, plan_names, doc_names, b) for t in tasks]


def _get_task(db: Session, pid: str, tid: str) -> ProjectTask:
    t = db.get(ProjectTask, tid)
    if t is None or t.project_id != pid:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Aufgabe nicht gefunden")
    return t


def _validate_task_refs(db: Session, user: User, pid: str, fields: dict) -> None:
    """Zuständige(r), Plan und Dokument müssen zum Projekt gehören."""
    aid = fields.get("assignee_id")
    if aid:
        au = db.get(User, aid)
        if au is None or not au.is_active or project_role(db, au, pid) is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Zuständige(r) ist kein Projektmitglied")
    plan_id = fields.get("plan_id")
    if plan_id:
        pl = db.get(Plan, plan_id)
        if (pl is None or pl.project_id != pid or pl.deleted_at is not None
                or effective_level(db, user, pl) is None):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Plan gehört nicht zum Projekt")
    doc_id = fields.get("doc_id")
    if doc_id:
        d = db.get(ProjectDoc, doc_id)
        if d is None or d.project_id != pid or d.kind != "doc":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Dokument gehört nicht zum Projekt")
        if d.space == "builder" and not effective_mission_builder(db, user):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Dokument gehört nicht zum Projekt")


def _column(db: Session, pid: str, st: str, exclude: str | None = None) -> list[ProjectTask]:
    q = select(ProjectTask).where(ProjectTask.project_id == pid, ProjectTask.status == st)
    if exclude:
        q = q.where(ProjectTask.id != exclude)
    return list(db.scalars(q.order_by(ProjectTask.ordering, ProjectTask.created_at)))


def _set_status(t: ProjectTask, st: str) -> None:
    t.status = st
    t.done_at = now() if st == "done" else None


@router.get("/{pid}/tasks")
def list_tasks(
    pid: str, user: CurrentUser, db: DbDep, assignee: str | None = None,
    status_: Annotated[str | None, Query(alias="status", pattern=r"^(open|doing|review|done)$")] = None,
) -> list[dict]:
    _ctx(db, user, pid)
    q = select(ProjectTask).where(ProjectTask.project_id == pid)
    if assignee:
        q = q.where(ProjectTask.assignee_id == (user.id if assignee == "me" else assignee))
    if status_:
        q = q.where(ProjectTask.status == status_)
    return _tasks_out(db, user, list(db.scalars(q.order_by(ProjectTask.ordering, ProjectTask.created_at))))


@router.post("/{pid}/tasks", status_code=status.HTTP_201_CREATED)
def create_task(pid: str, body: TaskCreateIn, request: Request, user: CurrentUser, db: DbDep) -> dict:
    _ctx(db, user, pid, "editor", write=True)
    title = body.title.strip()
    if not title:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Titel fehlt")
    if db.scalar(select(func.count(ProjectTask.id)).where(ProjectTask.project_id == pid)) >= _MAX_TASKS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Zu viele Aufgaben")
    _validate_task_refs(db, user, pid, body.model_dump())
    nxt = db.scalar(select(func.coalesce(func.max(ProjectTask.ordering), -1)).where(
        ProjectTask.project_id == pid, ProjectTask.status == body.status))
    t = ProjectTask(
        project_id=pid, title=title, description=body.description, priority=body.priority,
        assignee_id=body.assignee_id or None, due_date=body.due_date, plan_id=body.plan_id or None,
        doc_id=body.doc_id or None, ordering=int(nxt) + 1, created_by=user.id, updated_by=user.id,
    )
    _set_status(t, body.status)
    db.add(t)
    db.commit()
    _audit(db, request, user, "project.task.create", "project_task", t.id, project_id=pid)
    return _tasks_out(db, user, [t])[0]


@router.patch("/{pid}/tasks/{tid}")
def patch_task(
    pid: str, tid: str, body: TaskPatchIn, request: Request, user: CurrentUser, db: DbDep
) -> dict:
    _ctx(db, user, pid, "editor", write=True)
    t = _get_task(db, pid, tid)
    sent = body.model_fields_set
    refs = {k: getattr(body, k) for k in ("assignee_id", "plan_id", "doc_id") if k in sent}
    _validate_task_refs(db, user, pid, refs)
    if body.title is not None:
        if not body.title.strip():
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Titel fehlt")
        t.title = body.title.strip()
    if body.description is not None:
        t.description = body.description
    if body.priority is not None:
        t.priority = body.priority
    for k, v in refs.items():
        setattr(t, k, v or None)
    if "due_date" in sent:
        t.due_date = body.due_date
    if body.status is not None and body.status != t.status:
        last = max((x.ordering for x in _column(db, pid, body.status)), default=-1)
        _set_status(t, body.status)
        t.ordering = last + 1
    t.updated_by = user.id
    t.updated_at = now()
    db.commit()
    _audit(db, request, user, "project.task.update", "project_task", t.id, project_id=pid)
    return _tasks_out(db, user, [t])[0]


@router.post("/{pid}/tasks/{tid}/move")
def move_task(pid: str, tid: str, body: TaskMoveIn, user: CurrentUser, db: DbDep) -> dict:
    """Aufgabe in Spalte `status` an Position `ordering` einsortieren (Spalte wird neu durchnummeriert)."""
    _ctx(db, user, pid, "editor", write=True)
    t = _get_task(db, pid, tid)
    col = _column(db, pid, body.status, exclude=t.id)
    if t.status != body.status:
        _set_status(t, body.status)
    col.insert(min(body.ordering, len(col)), t)
    for idx, x in enumerate(col):
        x.ordering = idx
    t.updated_by = user.id
    t.updated_at = now()
    db.commit()
    return _tasks_out(db, user, [t])[0]


@router.delete("/{pid}/tasks/{tid}")
def delete_task(pid: str, tid: str, request: Request, user: CurrentUser, db: DbDep) -> dict:
    _ctx(db, user, pid, "editor", write=True)
    db.delete(_get_task(db, pid, tid))
    db.commit()
    _audit(db, request, user, "project.task.delete", "project_task", tid, project_id=pid)
    return {"ok": True}


# ─── Pläne & Übersicht ─────────────────────────────────────────────────────

@router.get("/{pid}/plans", response_model=list[PlanListItem])
def project_plans(pid: str, user: CurrentUser, db: DbDep) -> list[PlanListItem]:
    _ctx(db, user, pid)
    out: list[PlanListItem] = []
    for plan in db.scalars(select(Plan).where(Plan.project_id == pid, Plan.deleted_at.is_(None))
                           .order_by(Plan.updated_at.desc())):
        level = effective_level(db, user, plan)
        if level is not None:
            out.append(PlanListItem(**PlanOut.model_validate(plan).model_dump(), level=level))
    return out


@router.get("/{pid}/overview")
def overview(pid: str, user: CurrentUser, db: DbDep) -> dict:
    _ctx(db, user, pid)
    is_b = effective_mission_builder(db, user)
    tasks = list(db.scalars(select(ProjectTask).where(ProjectTask.project_id == pid)))
    open_t = [t for t in tasks if t.status != "done"]

    by: dict[str | None, dict] = {}
    for t in open_t:
        r = by.setdefault(t.assignee_id, {"user_id": t.assignee_id, "open": 0, "doing": 0, "review": 0})
        r[{"open": "open", "doing": "doing", "review": "review"}[t.status]] += 1
    labels = _labels(db, [k for k in by if k])
    open_by = [{**r, "label": labels.get(r["user_id"] or "", "")} for r in by.values()]
    open_by.sort(key=lambda r: (r["user_id"] is None, r["label"].lower()))

    today = date.today()
    soon = today + timedelta(days=7)
    due = sorted((t for t in open_t if t.due_date), key=lambda t: t.due_date)
    due_soon = [t for t in due if today <= t.due_date <= soon]
    overdue = [t for t in due if t.due_date < today]

    doc_q = select(ProjectDoc).where(ProjectDoc.project_id == pid, ProjectDoc.kind == "doc")
    if not is_b:
        doc_q = doc_q.where(ProjectDoc.space == "public")
    docs = list(db.scalars(doc_q.order_by(ProjectDoc.updated_at.desc()).limit(8)))
    dlabels = _labels(db, [d.updated_by for d in docs])
    n_docs = db.scalar(select(func.count()).select_from(doc_q.subquery()))

    plans = [p for p in db.scalars(select(Plan).where(Plan.project_id == pid, Plan.deleted_at.is_(None))
                                   .order_by(Plan.updated_at.desc()))
             if effective_level(db, user, p) is not None]  # nur per Plan-ACL sichtbare Pläne
    imgs = list(db.scalars(select(PlanImage).join(Plan, Plan.id == PlanImage.plan_id)
                           .where(PlanImage.project_id == pid, Plan.deleted_at.is_(None))))
    if not is_b:
        sp = _image_spaces(db, imgs)
        imgs = [i for i in imgs if sp[i.id] == "public"]

    return {
        "open_by_assignee": open_by,
        "due_soon": _tasks_out(db, user, due_soon),
        "overdue": _tasks_out(db, user, overdue),
        "recent_docs": [
            {"id": d.id, "name": d.name, "space": d.space, "updated_at": _iso(d.updated_at),
             "updated_by": dlabels.get(d.updated_by or "", None)} for d in docs
        ],
        "recent_plans": [{"id": p.id, "name": p.name, "updated_at": _iso(p.updated_at)} for p in plans[:8]],
        "counts": {"docs": int(n_docs or 0), "images": len(imgs), "plans": len(plans), "tasks_open": len(open_t)},
    }
