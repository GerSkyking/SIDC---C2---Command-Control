"""@-Erwähnungen: @name (Nutzer), @gruppe, @projekt.

Ein Handle ist der kleingeschriebene Name ohne Leerraum (Leerzeichen -> „_“). Nutzer sind über
Login-Namen *und* Anzeigenamen erreichbar. Aufgelöst wird beim Speichern; das Ergebnis steht als
Liste ``[{"type": "user"|"group"|"project", "id": ..., "token": "name"}]`` am Eintrag und dient
später als Grundlage für Benachrichtigungen.
"""
from __future__ import annotations

import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Group, GroupMember, ProjectMember, User

PROJECT_HANDLES = {"projekt", "project", "alle", "all"}
_TOKEN = re.compile(r"(?<![\w@])@([^\s@,;:!?()\[\]<>\"']+)")


def handle(s: str) -> str:
    return re.sub(r"\s+", "_", (s or "").strip()).lower()


def project_user_ids(db: Session, pid: str) -> set[str]:
    """Aktive Nutzer mit Projektzugriff (direkt oder über Gruppe)."""
    ids: set[str] = set()
    for m in db.scalars(select(ProjectMember).where(ProjectMember.project_id == pid)):
        if m.subject_type == "user":
            ids.add(m.subject_id)
        else:
            ids.update(db.scalars(select(GroupMember.user_id).where(GroupMember.group_id == m.subject_id)))
    if not ids:
        return ids
    return set(db.scalars(select(User.id).where(User.id.in_(ids), User.is_active.is_(True))))


def mention_candidates(db: Session, pid: str | None = None) -> list[dict]:
    """Vorschläge für die Autovervollständigung. Mit ``pid``: Nutzer des Projekts + @projekt;
    ohne: alle aktiven Nutzer (Chat)."""
    if pid is None:
        users = list(db.scalars(select(User).where(User.is_active.is_(True))))
    else:
        ids = project_user_ids(db, pid)
        users = list(db.scalars(select(User).where(User.id.in_(ids)))) if ids else []
    out = [{"type": "user", "id": u.id, "handle": handle(u.username), "label": u.label} for u in users]
    out += [{"type": "group", "id": g.id, "handle": handle(g.name), "label": g.name} for g in db.scalars(select(Group))]
    if pid is not None:
        out.append({"type": "project", "id": pid, "handle": "projekt", "label": ""})
    out.sort(key=lambda c: ({"user": 0, "group": 1, "project": 2}[c["type"]], c["label"].lower()))
    return out


def resolve_mentions(db: Session, text: str, pid: str | None = None) -> list[dict]:
    """Findet @tokens im Text und ordnet sie Nutzern/Gruppen/Projekt zu (unbekannte werden ignoriert)."""
    tokens = []
    for m in _TOKEN.finditer(text or ""):
        tok = m.group(1).rstrip(".")
        if tok and tok.lower() not in tokens:
            tokens.append(tok.lower())
    if not tokens:
        return []
    cands = mention_candidates(db, pid)
    by_login: dict[str, dict] = {}
    by_label: dict[str, dict] = {}
    groups: dict[str, dict] = {}
    for c in cands:
        if c["type"] == "user":
            by_login.setdefault(c["handle"], c)
            by_label.setdefault(handle(c["label"]), c)
        elif c["type"] == "group":
            groups.setdefault(c["handle"], c)
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for tok in tokens:
        h = handle(tok)
        hit = None
        if pid is not None and h in PROJECT_HANDLES:
            hit = {"type": "project", "id": pid}
        else:
            hit = by_login.get(h) or by_label.get(h) or groups.get(h)
        if hit and (hit["type"], hit["id"]) not in seen:
            seen.add((hit["type"], hit["id"]))
            out.append({"type": hit["type"], "id": hit["id"], "token": tok})
    return out


def mention_recipients(db: Session, pid: str | None, mentions: list[dict], exclude: str | None = None) -> set[str]:
    """Nutzer-IDs, die durch die Erwähnungen angesprochen werden (Gruppen aufgelöst, nur mit
    Projektzugriff, ohne ``exclude`` = Autor)."""
    access = project_user_ids(db, pid) if pid else None
    ids: set[str] = set()
    for m in mentions:
        if m["type"] == "user":
            ids.add(m["id"])
        elif m["type"] == "group":
            ids.update(db.scalars(select(GroupMember.user_id).where(GroupMember.group_id == m["id"])))
        elif m["type"] == "project" and access is not None:
            ids.update(access)
    if access is not None:
        ids &= access
    ids.discard(exclude or "")
    return ids
