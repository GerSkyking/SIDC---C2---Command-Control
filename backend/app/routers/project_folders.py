"""Ordner der Projektliste (Projekte als Ordnerstruktur). Spezifikation: docs/PROJEKTE.md §7.1."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from .. import audit
from ..deps import CurrentUser, DbDep
from ..models import GroupMember, Project, ProjectFolder, ProjectMember, User
from ..permissions import effective_mission_builder
from ..schemas import ProjectFolderIn, ProjectFolderPatchIn

router = APIRouter(prefix="/project-folders", tags=["projects"])


def _out(f: ProjectFolder) -> dict:
    return {"id": f.id, "name": f.name, "parent_id": f.parent_id, "ordering": f.ordering,
            "created_by": f.created_by}


def visible_project_ids(db: Session, user: User) -> set[str]:
    """Projekte, in denen der Nutzer Mitglied ist (Admin: alle)."""
    if user.is_admin:
        return set(db.scalars(select(Project.id)))
    gids = list(db.scalars(select(GroupMember.group_id).where(GroupMember.user_id == user.id)))
    subj = {("user", user.id), *(("group", g) for g in gids)}
    return {m.project_id for m in db.scalars(select(ProjectMember)) if (m.subject_type, m.subject_id) in subj}


def visible_folder_ids(db: Session, user: User) -> set[str]:
    """Admin: alle. Sonst Ordner mit sichtbaren Projekten (auch indirekt), deren Vorfahren,
    plus selbst angelegte Ordner (samt Vorfahren)."""
    folders = {f.id: f for f in db.scalars(select(ProjectFolder))}
    if user.is_admin:
        return set(folders)
    vis_proj = visible_project_ids(db, user)
    seeds: set[str] = set()
    if vis_proj:
        seeds = {p.folder_id for p in db.scalars(select(Project).where(Project.id.in_(vis_proj))) if p.folder_id}
    seeds |= {f.id for f in folders.values() if f.created_by == user.id}
    out: set[str] = set()
    for fid in seeds:
        cur = fid
        while cur and cur in folders and cur not in out:
            out.add(cur)
            cur = folders[cur].parent_id
    return out


def can_use_folder(db: Session, user: User, folder_id: str) -> bool:
    """Darf der Nutzer ein Projekt/einen Ordner in diesen Ordner legen/verschieben?"""
    if db.get(ProjectFolder, folder_id) is None:
        return False
    return effective_mission_builder(db, user) or folder_id in visible_folder_ids(db, user)


def _is_descendant(db: Session, folder_id: str, maybe_ancestor_id: str) -> bool:
    seen: set[str] = set()
    cur: str | None = folder_id
    while cur and cur not in seen:
        if cur == maybe_ancestor_id:
            return True
        seen.add(cur)
        f = db.get(ProjectFolder, cur)
        cur = f.parent_id if f else None
    return False


def _owned(db: Session, user: User, folder_id: str) -> ProjectFolder:
    f = db.get(ProjectFolder, folder_id)
    if f is None or (not user.is_admin and folder_id not in visible_folder_ids(db, user)):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ordner nicht gefunden")
    if not user.is_admin and f.created_by != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Nur Admin oder Ersteller des Ordners")
    return f


@router.get("")
def list_folders(user: CurrentUser, db: DbDep) -> list[dict]:
    vis = visible_folder_ids(db, user)
    rows = db.scalars(select(ProjectFolder).order_by(ProjectFolder.ordering, ProjectFolder.name))
    return [_out(f) for f in rows if f.id in vis]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_folder(body: ProjectFolderIn, request: Request, user: CurrentUser, db: DbDep) -> dict:
    if not effective_mission_builder(db, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Nur Missionsbauer dürfen Projekt-Ordner anlegen")
    name = body.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Name fehlt")
    if body.parent_id is not None and not can_use_folder(db, user, body.parent_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ordner nicht gefunden")
    nxt = db.scalar(select(func.coalesce(func.max(ProjectFolder.ordering), -1)))
    f = ProjectFolder(name=name[:120], parent_id=body.parent_id, ordering=int(nxt) + 1, created_by=user.id)
    db.add(f)
    db.commit()
    audit.record(db, "project.folder.create", user_id=user.id, target_type="project_folder",
                 target_id=f.id, request=request, name=f.name)
    return _out(f)


@router.patch("/{folder_id}")
def patch_folder(folder_id: str, body: ProjectFolderPatchIn, request: Request,
                 user: CurrentUser, db: DbDep) -> dict:
    f = _owned(db, user, folder_id)
    if body.name is not None:
        if not body.name.strip():
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Name fehlt")
        f.name = body.name.strip()[:120]
    if body.parent_id is not None:
        if body.parent_id == folder_id or _is_descendant(db, body.parent_id, folder_id):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Zyklus im Ordnerbaum")
        if not can_use_folder(db, user, body.parent_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Zielordner nicht gefunden")
        f.parent_id = body.parent_id
    elif body.move_to_root:
        f.parent_id = None
    if body.ordering is not None:
        f.ordering = body.ordering
    db.commit()
    audit.record(db, "project.folder.update", user_id=user.id, target_type="project_folder",
                 target_id=f.id, request=request, name=f.name)
    return _out(f)


@router.delete("/{folder_id}")
def delete_folder(folder_id: str, request: Request, user: CurrentUser, db: DbDep) -> dict:
    f = _owned(db, user, folder_id)
    # Inhalt (Unterordner + Projekte) rückt eine Ebene nach oben (explizit: SQLite ohne FK-Erzwingung)
    db.execute(update(ProjectFolder).where(ProjectFolder.parent_id == folder_id).values(parent_id=f.parent_id))
    db.execute(update(Project).where(Project.folder_id == folder_id).values(folder_id=f.parent_id))
    name = f.name
    db.delete(f)
    db.commit()
    audit.record(db, "project.folder.delete", user_id=user.id, target_type="project_folder",
                 target_id=folder_id, request=request, name=name)
    return {"ok": True}
