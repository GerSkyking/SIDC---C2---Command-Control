"""Missionsbau-Werkzeuge (Phase 1): Verknüpfungs-Codes auflösen, Rückverweise, Suche, Zeitleiste.

Rechte wie im Projekt: Projektmitglieder lesen; der Missionsbau-Bereich (space == "builder",
auch Bilder aus Builder-Phasen) nur Missionsbauer; Pläne nur bei Plan-Recht (effective_level).
Nicht erlaubte oder fehlende Ziele erscheinen als ``ok: false`` ohne Namen. Spezifikation:
docs/MISSIONSBAU-WERKZEUGE.md. Alle Endpunkte sind plain ``def`` (Threadpool).
"""
from __future__ import annotations

import json
import re
from typing import Annotated, Literal
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..deps import CurrentUser, DbDep
from ..models import (
    Annotation,
    Map,
    Phase,
    Plan,
    PlanImage,
    ProjectDoc,
    ProjectNote,
    ProjectRef,
    ProjectTask,
    ProjectTimelineEntry,
    User,
)
from ..permissions import effective_level, effective_mission_builder
from ..services.maps_import import map_dir
from .projects import _SPACE_Q, _ctx, _image_spaces

router = APIRouter(prefix="/projects", tags=["project-tools"])

RefType = Literal["doc", "task", "plan", "note", "img", "place"]
_HEX32 = re.compile(r"^[0-9a-f]{32}$")
_MAX_RESOLVE = 200
_SPACE_LABEL = {"public": "Öffentlich", "builder": "Missionsbau"}
_STATUS_LABEL = {"open": "Offen", "doing": "In Arbeit", "review": "Review", "done": "Erledigt"}
_SEARCH_TYPES = ("doc", "task", "plan", "note", "img")


class RefIn(BaseModel):
    type: RefType
    id: str = Field(max_length=300)


class ResolveIn(BaseModel):
    refs: list[RefIn] = Field(max_length=_MAX_RESOLVE)


# ─── Orte (locations.json) ─────────────────────────────────────────────────

_loc_cache: dict[str, tuple[int, dict[str, str]]] = {}  # map_id -> (mtime_ns, {Name -> Name})
_LOC_CACHE_MAX = 8


def _place_names(map_id: str) -> dict[str, str]:
    """Alle Ortsnamen (aller Sprachen) einer Karte aus locations.json; leer, wenn nicht vorhanden."""
    try:
        p = map_dir(map_id) / "locations.json"
        mt = p.stat().st_mtime_ns
    except (OSError, HTTPException):
        return {}
    hit = _loc_cache.get(map_id)
    if hit is not None and hit[0] == mt:
        return hit[1]
    names: dict[str, str] = {}
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
        for g in doc.get("groups", []):
            for it in g.get("items", []):
                for n in (it.get("names") or {}).values():
                    if isinstance(n, str) and n.strip():
                        names[n.strip()] = n.strip()
    except (OSError, ValueError, AttributeError, TypeError):
        names = {}
    if len(_loc_cache) >= _LOC_CACHE_MAX:
        _loc_cache.pop(next(iter(_loc_cache)))
    _loc_cache[map_id] = (mt, names)
    return names


# ─── Auflösung ─────────────────────────────────────────────────────────────

def _first_line(text: str, n: int = 80) -> str:
    for ln in (text or "").splitlines():
        if ln.strip():
            return ln.strip()[:n]
    return "(leere Notiz)"


def _href_doc(pid: str, space: str, doc_id: str) -> str:
    return f"#/projects/{pid}/{space}?doc={doc_id}"


def _item(typ: str, tid: str, label: str, sub: str, href: str) -> dict:
    return {"type": typ, "id": tid, "label": label, "sub": sub, "href": href, "ok": True}


def _missing(typ: str, tid: str) -> dict:
    return {"type": typ, "id": tid, "label": "", "sub": "", "href": "", "ok": False}


def resolve_refs(db: Session, user: User, pid: str, refs: list[tuple[str, str]]) -> list[dict]:
    """Ein Ergebnis je Eingabe (gleiche Reihenfolge). Prüft Projektzugehörigkeit, Bereich und Plan-Rechte."""
    is_b = effective_mission_builder(db, user)
    ids: dict[str, set[str]] = {t: set() for t in ("doc", "task", "plan", "note", "img", "annotation")}
    for typ, tid in refs:
        if typ in ids and _HEX32.match(tid):
            ids[typ].add(tid)
    found: dict[tuple[str, str], dict] = {}

    if ids["doc"]:
        for d in db.scalars(select(ProjectDoc).where(
                ProjectDoc.project_id == pid, ProjectDoc.id.in_(ids["doc"]), ProjectDoc.kind == "doc")):
            if d.space == "builder" and not is_b:
                continue
            found[("doc", d.id)] = _item("doc", d.id, d.name, _SPACE_LABEL.get(d.space, d.space),
                                         _href_doc(pid, d.space, d.id))
    if ids["task"]:
        for t in db.scalars(select(ProjectTask).where(
                ProjectTask.project_id == pid, ProjectTask.id.in_(ids["task"]))):
            found[("task", t.id)] = _item("task", t.id, t.title, _STATUS_LABEL.get(t.status, t.status),
                                          f"#/projects/{pid}/tasks?task={t.id}")
    if ids["plan"]:
        plans = list(db.scalars(select(Plan).where(
            Plan.project_id == pid, Plan.id.in_(ids["plan"]), Plan.deleted_at.is_(None))))
        mids = {p.map_id for p in plans if p.map_id}
        mnames = {m.id: m.name for m in db.scalars(select(Map).where(Map.id.in_(mids)))} if mids else {}
        for p in plans:
            if effective_level(db, user, p) is not None:
                found[("plan", p.id)] = _item("plan", p.id, p.name, mnames.get(p.map_id or "", ""),
                                              f"#/plans/{p.id}")
    if ids["note"]:
        for n in db.scalars(select(ProjectNote).where(
                ProjectNote.project_id == pid, ProjectNote.id.in_(ids["note"]))):
            found[("note", n.id)] = _item("note", n.id, _first_line(n.text), "Haftnotiz",
                                          f"#/projects/{pid}/whiteboard?note={n.id}")
    if ids["img"]:
        imgs = list(db.scalars(
            select(PlanImage).join(Plan, Plan.id == PlanImage.plan_id)
            .where(PlanImage.project_id == pid, PlanImage.id.in_(ids["img"]), Plan.deleted_at.is_(None))))
        spaces = _image_spaces(db, imgs)
        pn = {p.id: p.name for p in db.scalars(select(Plan).where(Plan.id.in_({i.plan_id for i in imgs})))} if imgs else {}
        for i in imgs:
            sp = spaces[i.id]
            if sp == "builder" and not is_b:
                continue
            found[("img", i.id)] = _item("img", i.id, i.caption or i.filename, pn.get(i.plan_id, ""),
                                         f"#/projects/{pid}/{sp}?img={i.id}")

    if ids["annotation"]:  # nur als Rückverweis-Quelle: Annotation auf der Karte eines Plans dieses Projekts
        rows = list(db.execute(
            select(Annotation, Plan).join(Plan, Plan.id == Annotation.plan_id)
            .where(Plan.project_id == pid, Plan.deleted_at.is_(None), Annotation.id.in_(ids["annotation"]))).all())
        pids_ = {a.phase_id for a, _ in rows if a.phase_id}
        planes = dict(db.execute(select(Phase.id, Phase.plane).where(Phase.id.in_(pids_))).all()) if pids_ else {}
        levels: dict[str, bool] = {}
        for a, p in rows:
            if planes.get(a.phase_id or "") == "builder" and not is_b:
                continue
            if p.id not in levels:
                levels[p.id] = effective_level(db, user, p) is not None
            if levels[p.id]:
                found[("annotation", a.id)] = _item("annotation", a.id, f"{p.name} (Karte)", "Karten-Verweis", f"#/plans/{p.id}")

    maps: dict[str, Map | None] = {}
    out: list[dict] = []
    for typ, tid in refs:
        if typ == "place":
            mid, _, name = tid.partition(":")
            name = name.strip()
            if mid not in maps:
                maps[mid] = db.get(Map, mid) if mid else None
            m = maps[mid]
            if m is not None and name and name in _place_names(mid):
                out.append(_item("place", tid, name, m.name,
                                 f"#/projects/{pid}/places?map={quote(mid, safe='')}&name={quote(name, safe='')}"))
            else:
                out.append(_missing(typ, tid))
        else:
            out.append(found.get((typ, tid)) or _missing(typ, tid))
    return out


@router.post("/{pid}/refs/resolve")
def resolve(pid: str, body: ResolveIn, user: CurrentUser, db: DbDep) -> list[dict]:
    _ctx(db, user, pid)
    return resolve_refs(db, user, pid, [(r.type, r.id) for r in body.refs])


@router.get("/{pid}/refs/backlinks")
def backlinks(
    pid: str, user: CurrentUser, db: DbDep, type: RefType, id: Annotated[str, Query(max_length=300)],
) -> list[dict]:
    """Quellen (Dateien, Aufgaben, Notizen, Annotationen auf Plankarten), die das Ziel erwähnen; nur sichtbare Quellen.
    Ist das Ziel selbst nicht sichtbar/vorhanden, kommt eine leere Liste."""
    _ctx(db, user, pid)
    if not resolve_refs(db, user, pid, [(type, id)])[0]["ok"]:
        return []
    rows = list(db.scalars(select(ProjectRef).where(
        ProjectRef.project_id == pid, ProjectRef.target_type == type, ProjectRef.target_id == id)))
    srcs = list(dict.fromkeys((r.source_type, r.source_id) for r in rows))
    res = resolve_refs(db, user, pid, srcs)
    out = [{"type": r["type"], "id": r["id"], "label": r["label"], "href": r["href"]} for r in res if r["ok"]]
    out.sort(key=lambda x: (x["type"], x["label"].lower()))
    return out


# ─── Suche ─────────────────────────────────────────────────────────────────

def _like(q: str) -> str:
    """LIKE-Muster mit maskierten Wildcards (escape = Backslash)."""
    return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _snippet(text: str, q: str, width: int = 120) -> str:
    """Ausschnitt (~width Zeichen) um den ersten Treffer; leer, wenn q nicht vorkommt."""
    text = re.sub(r"\s+", " ", text or "")
    i = text.lower().find(q.lower())
    if i < 0:
        return ""
    start = max(0, i - (width - len(q)) // 3)
    end = min(len(text), start + width)
    start = max(0, end - width)
    return ("…" if start > 0 else "") + text[start:end].strip() + ("…" if end < len(text) else "")


@router.get("/{pid}/search")
def search(
    pid: str, user: CurrentUser, db: DbDep,
    q: Annotated[str, Query(max_length=100)],
    types: Annotated[str | None, Query(max_length=60)] = None,
    space: Annotated[str | None, Query(pattern=r"^(public|builder)$")] = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> list[dict]:
    """Treffer in Titel und Inhalt (Dateien, Aufgaben inkl. Beschreibung, Notizen, Plan- und Bildnamen);
    Titeltreffer zuerst. ``space`` beschränkt Dateien und Bilder auf einen Bereich."""
    _ctx(db, user, pid)
    q = q.strip()
    if len(q) < 2:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Suchbegriff zu kurz (mindestens 2 Zeichen)")
    want = [x for x in (types or "").split(",") if x] or list(_SEARCH_TYPES)
    if any(x not in _SEARCH_TYPES for x in want):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unbekannter Typ")
    is_b = effective_mission_builder(db, user)
    if space == "builder" and not is_b:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nicht gefunden")
    pat = _like(q)
    title_hits: list[dict] = []
    body_hits: list[dict] = []

    def add(lst: list[dict], hit: dict) -> None:
        lst.append(hit)

    if "doc" in want:
        base = select(ProjectDoc).where(ProjectDoc.project_id == pid, ProjectDoc.kind == "doc")
        if space:
            base = base.where(ProjectDoc.space == space)
        elif not is_b:
            base = base.where(ProjectDoc.space == "public")
        seen: set[str] = set()
        for d in db.scalars(base.where(ProjectDoc.name.ilike(pat, escape="\\")).order_by(ProjectDoc.name).limit(limit)):
            seen.add(d.id)
            add(title_hits, {"type": "doc", "id": d.id, "label": d.name, "sub": _SPACE_LABEL[d.space],
                             "href": _href_doc(pid, d.space, d.id), "snippet": _snippet(d.content, q)})
        for d in db.scalars(base.where(ProjectDoc.content.ilike(pat, escape="\\")).order_by(ProjectDoc.name).limit(limit)):
            if d.id not in seen:
                add(body_hits, {"type": "doc", "id": d.id, "label": d.name, "sub": _SPACE_LABEL[d.space],
                                "href": _href_doc(pid, d.space, d.id), "snippet": _snippet(d.content, q)})
    if "task" in want:
        base = select(ProjectTask).where(ProjectTask.project_id == pid)
        seen = set()
        for t in db.scalars(base.where(ProjectTask.title.ilike(pat, escape="\\")).order_by(ProjectTask.title).limit(limit)):
            seen.add(t.id)
            add(title_hits, {"type": "task", "id": t.id, "label": t.title, "sub": _STATUS_LABEL.get(t.status, t.status),
                             "href": f"#/projects/{pid}/tasks?task={t.id}", "snippet": _snippet(t.description, q)})
        for t in db.scalars(base.where(ProjectTask.description.ilike(pat, escape="\\")).order_by(ProjectTask.title).limit(limit)):
            if t.id not in seen:
                add(body_hits, {"type": "task", "id": t.id, "label": t.title, "sub": _STATUS_LABEL.get(t.status, t.status),
                                "href": f"#/projects/{pid}/tasks?task={t.id}", "snippet": _snippet(t.description, q)})
    if "note" in want:
        for n in db.scalars(select(ProjectNote).where(
                ProjectNote.project_id == pid, ProjectNote.text.ilike(pat, escape="\\"))
                .order_by(ProjectNote.created_at).limit(limit)):
            add(body_hits, {"type": "note", "id": n.id, "label": _first_line(n.text), "sub": "Haftnotiz",
                            "href": f"#/projects/{pid}/whiteboard?note={n.id}", "snippet": _snippet(n.text, q)})
    if "plan" in want:
        n_ok = 0
        for p in db.scalars(select(Plan).where(
                Plan.project_id == pid, Plan.deleted_at.is_(None), Plan.name.ilike(pat, escape="\\"))
                .order_by(Plan.name)):
            if n_ok >= limit:
                break
            if effective_level(db, user, p) is not None:
                n_ok += 1
                add(title_hits, {"type": "plan", "id": p.id, "label": p.name, "sub": "Plan",
                                 "href": f"#/plans/{p.id}", "snippet": ""})
    if "img" in want:
        rows = list(db.scalars(
            select(PlanImage).join(Plan, Plan.id == PlanImage.plan_id)
            .where(PlanImage.project_id == pid, Plan.deleted_at.is_(None),
                   or_(PlanImage.filename.ilike(pat, escape="\\"), PlanImage.caption.ilike(pat, escape="\\"),
                       PlanImage.note.ilike(pat, escape="\\")))
            .order_by(PlanImage.created_at.desc())
        ))
        spaces = _image_spaces(db, rows)
        n_ok = 0
        for i in rows:
            sp = spaces[i.id]
            if (sp == "builder" and not is_b) or (space and sp != space) or n_ok >= limit:
                continue
            n_ok += 1
            label = i.caption or i.filename
            hit = {"type": "img", "id": i.id, "label": label, "sub": _SPACE_LABEL[sp],
                   "href": f"#/projects/{pid}/{sp}?img={i.id}", "snippet": _snippet(i.note, q)}
            title = q.lower() in (i.filename or "").lower() or q.lower() in (i.caption or "").lower()
            add(title_hits if title else body_hits, hit)
    return (title_hits + body_hits)[:limit]


# ─── Zeitleiste ────────────────────────────────────────────────────────────

@router.get("/{pid}/timeline")
def timeline(pid: str, user: CurrentUser, db: DbDep) -> list[dict]:
    """Zeitleisten-Einträge aller Dateien, sortiert (Tag/Uhrzeit, dann relative Zeiten); Missionsbau
    nur für Missionsbauer."""
    _ctx(db, user, pid)
    q = select(ProjectTimelineEntry).where(ProjectTimelineEntry.project_id == pid)
    if not effective_mission_builder(db, user):
        q = q.where(ProjectTimelineEntry.space == "public")
    rows = list(db.scalars(q))
    names = {d.id: d.name for d in db.scalars(select(ProjectDoc).where(
        ProjectDoc.id.in_({r.doc_id for r in rows})))} if rows else {}
    rows = [r for r in rows if r.doc_id in names]
    rows.sort(key=lambda r: (r.ord_key, names[r.doc_id].lower(), r.position))
    return [
        {"doc_id": r.doc_id, "doc_name": names[r.doc_id], "space": r.space, "heading": r.heading,
         "level": r.level, "day": r.day, "minutes": r.minutes, "relative": bool(r.relative),
         "position": r.position, "href": f"{_href_doc(pid, r.space, r.doc_id)}&line={r.position}"}
        for r in rows
    ]
