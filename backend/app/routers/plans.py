"""Plan-Lebenszyklus: CRUD, ACL, Klonen, Versionen, Snapshot-Laden."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel

from ..config import get_settings
from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from .. import audit

from ..deps import CurrentUser, DbDep, load_plan, require_plan_level
from ..models import (
    Annotation,
    Layer,
    Marker,
    OrbatNode,
    Phase,
    Plan,
    PlanACL,
    PlanFolder,
    PlanVersion,
    Stroke,
    User,
    now,
)
from ..sidc_status import GENERIC_HOSTILE_SIDC, sidc_with_status
from ..permissions import (
    can_create_plans,
    effective_level,
    effective_mission_builder,
    rank,
)
from ..schemas import (
    ACLCandidate,
    ACLEntryIn,
    ACLOut,
    FolderIn,
    FolderPatchIn,
    PlanCloneIn,
    PlanCreateIn,
    PlanListItem,
    PlanMoveIn,
    PlanOut,
    PlanPatchIn,
    VersionCreateIn,
)

router = APIRouter(prefix="/plans", tags=["plans"])
folders_router = APIRouter(prefix="/folders", tags=["folders"])

EditorPlan = Annotated[Plan, Depends(require_plan_level("editor"))]
OwnerPlan = Annotated[Plan, Depends(require_plan_level("owner"))]
ViewerPlan = Annotated[Plan, Depends(require_plan_level("viewer"))]


def _builder_phase_ids(db: Session, plan_id: str) -> set[str]:
    return set(
        db.scalars(
            select(Phase.id).where(Phase.plan_id == plan_id, Phase.plane == "builder")
        )
    )


def _snapshot(db: Session, plan: Plan, *, include_builder: bool = True) -> dict:
    markers = list(db.scalars(select(Marker).where(Marker.plan_id == plan.id)))
    strokes = list(db.scalars(select(Stroke).where(Stroke.plan_id == plan.id)))
    anns = list(db.scalars(select(Annotation).where(Annotation.plan_id == plan.id)))
    if not include_builder:
        hide = _builder_phase_ids(db, plan.id)
        markers = [m for m in markers if m.phase_id not in hide]
        strokes = [s for s in strokes if s.phase_id not in hide]
        anns = [a for a in anns if a.phase_id not in hide]
    return {
        "markers": [_marker_dict(m) for m in markers],
        "strokes": [_stroke_dict(s) for s in strokes],
        "annotations": [_annotation_dict(a) for a in anns],
    }


def _builder_parent_map(db: Session, plan_id: str) -> dict[str, str | None]:
    return {
        p.id: p.parent_id
        for p in db.scalars(
            select(Phase).where(Phase.plan_id == plan_id, Phase.plane == "builder")
        )
    }


def released_markers(db: Session, plan_id: str) -> list[dict]:
    """Für Spieler freigegebene Feind-Marker: liegen auf einer Builder-Phase, sind mit
    einem ORBAT-Knoten mit ``rel_visible`` verknüpft. Rückgabe auf die gepaarte
    Spieler-Phase umgehängt, Typ ggf. auf ein generisches Feindsymbol reduziert."""
    bmap = _builder_parent_map(db, plan_id)
    if not bmap:
        return []
    out: list[dict] = []
    rows = db.scalars(
        select(Marker).where(
            Marker.plan_id == plan_id, Marker.orbat_node_id.is_not(None)
        )
    )
    for m in rows:
        if m.phase_id not in bmap:
            continue
        n = db.get(OrbatNode, m.orbat_node_id)
        if n is None or not n.rel_visible:
            continue
        base = m.sidc if n.rel_show_type else GENERIC_HOSTILE_SIDC
        d = _marker_dict(m)
        d.update(
            sidc=sidc_with_status(base, n.status),
            phase_id=bmap[m.phase_id],
            unit_text="", ai_text="", channel="",
            locked=True, orbat_node_id=None, released=True,
        )
        out.append(d)
    return out


def _annotation_dict(a: Annotation) -> dict:
    return {
        "id": a.id, "phase_id": a.phase_id, "world_x": a.world_x, "world_y": a.world_y,
        "text": a.text, "width": a.width, "height": a.height,
        "scale_fixed": a.scale_fixed, "ref_zoom": a.ref_zoom,
    }


def _marker_dict(m: Marker) -> dict:
    return {
        "id": m.id, "phase_id": m.phase_id, "layer_id": m.layer_id,
        "orbat_node_id": m.orbat_node_id, "orbat_strength": m.orbat_strength, "sidc": m.sidc,
        "world_x": m.world_x, "world_y": m.world_y, "rotation_degrees": m.rotation_degrees,
        "icon_rotation": m.icon_rotation, "scale": m.scale,
        "unit_text": m.unit_text, "ai_text": m.ai_text, "channel": m.channel,
        "locked": m.locked, "timestamp_visible": m.timestamp_visible,
        "linked_group_id": m.linked_group_id, "point_index": m.point_index,
        "line_color": m.line_color, "line_width": m.line_width,
    }


def _stroke_dict(s: Stroke) -> dict:
    return {
        "id": s.id, "phase_id": s.phase_id, "layer_id": s.layer_id, "kind": s.kind,
        "channel": s.channel, "points": s.points, "color": s.color, "width": s.width,
    }


# ─── CRUD ──────────────────────────────────────────────────────────────────

@router.get("", response_model=list[PlanListItem])
def list_plans(user: CurrentUser, db: DbDep) -> list[PlanListItem]:
    out: list[PlanListItem] = []
    for plan in db.scalars(select(Plan).where(Plan.deleted_at.is_(None)).order_by(Plan.updated_at.desc())):
        level = effective_level(db, user, plan)
        if level is not None:
            out.append(PlanListItem(**PlanOut.model_validate(plan).model_dump(), level=level))
    return out


@router.get("/trash", response_model=list[PlanListItem])
def list_trash(user: CurrentUser, db: DbDep) -> list[PlanListItem]:
    """Gelöschte Pläne, die man wiederherstellen darf (Owner/Admin)."""
    out: list[PlanListItem] = []
    for plan in db.scalars(select(Plan).where(Plan.deleted_at.is_not(None)).order_by(Plan.deleted_at.desc())):
        level = effective_level(db, user, plan)
        if rank(level) >= rank("owner"):
            out.append(PlanListItem(**PlanOut.model_validate(plan).model_dump(), level=level))
    return out


def _deleted_plan_owned(plan_id: str, user, db) -> Plan:
    plan = db.get(Plan, plan_id)
    if plan is None or plan.deleted_at is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nicht im Papierkorb")
    if rank(effective_level(db, user, plan)) < rank("owner"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Recht 'owner' erforderlich")
    return plan


@router.post("/{plan_id}/undelete", response_model=PlanOut)
def undelete_plan(plan_id: str, request: Request, user: CurrentUser, db: DbDep) -> Plan:
    plan = _deleted_plan_owned(plan_id, user, db)
    plan.deleted_at = None
    db.commit()
    audit.record(db, "plan.restore", user_id=user.id, target_type="plan", target_id=plan.id,
                 request=request, name=plan.name)
    return plan


@router.delete("/{plan_id}/purge")
def purge_plan(plan_id: str, request: Request, user: CurrentUser, db: DbDep) -> dict:
    plan = _deleted_plan_owned(plan_id, user, db)
    audit.record(db, "plan.purge", user_id=user.id, target_type="plan", target_id=plan.id,
                 request=request, name=plan.name)
    db.delete(plan)
    db.commit()
    _thumb_path(plan_id).unlink(missing_ok=True)
    return {"ok": True}


@router.post("", response_model=PlanOut, status_code=status.HTTP_201_CREATED)
def create_plan(body: PlanCreateIn, request: Request, user: CurrentUser, db: DbDep) -> Plan:
    if not can_create_plans(db, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Keine Berechtigung, Pläne zu erstellen")
    folder_id = body.folder_id or None
    if folder_id is not None and db.get(PlanFolder, folder_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ordner nicht gefunden")
    plan = Plan(name=body.name, map_id=body.map_id, folder_id=folder_id, created_by=user.id)
    db.add(plan)
    db.flush()
    db.add(PlanACL(plan_id=plan.id, subject_type="user", subject_id=user.id, level="owner"))
    db.add(Layer(plan_id=plan.id, name="Allgemein", is_default=True))
    base = Phase(plan_id=plan.id, name="Base", ordering=0)
    db.add(base)
    db.flush()
    db.add(Phase(plan_id=plan.id, name="Base", ordering=0, plane="builder", parent_id=base.id))
    db.commit()
    audit.record(db, "plan.create", user_id=user.id, target_type="plan", target_id=plan.id,
                 request=request, name=plan.name, map_id=plan.map_id)
    return plan


@router.get("/{plan_id}", response_model=PlanOut)
def get_plan(plan: ViewerPlan) -> Plan:
    return plan


@router.patch("/{plan_id}", response_model=PlanOut)
def patch_plan(body: PlanPatchIn, plan: EditorPlan, db: DbDep) -> Plan:
    """Umbenennen — Editor genügt (nicht nur Owner)."""
    if body.name is not None and body.name.strip():
        plan.name = body.name.strip()
    db.commit()
    return plan


@router.post("/{plan_id}/move", response_model=PlanOut)
def move_plan(body: PlanMoveIn, plan: EditorPlan, db: DbDep) -> Plan:
    """Plan in einen Ordner (oder auf die oberste Ebene, folder_id=null) verschieben."""
    if body.folder_id is not None and db.get(PlanFolder, body.folder_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ordner nicht gefunden")
    plan.folder_id = body.folder_id
    if body.ordering is not None:
        plan.ordering = body.ordering
    db.commit()
    return plan


# ─── Ordner (Plan-Gruppen) ─────────────────────────────────────────────────

def _folder_out(f: PlanFolder) -> dict:
    return {"id": f.id, "name": f.name, "parent_id": f.parent_id, "ordering": f.ordering}


def _is_descendant(db: Session, folder_id: str, maybe_ancestor_id: str) -> bool:
    """True, wenn maybe_ancestor_id im Elternpfad von folder_id liegt (Zyklus-Schutz)."""
    seen: set[str] = set()
    cur: str | None = folder_id
    while cur and cur not in seen:
        if cur == maybe_ancestor_id:
            return True
        seen.add(cur)
        f = db.get(PlanFolder, cur)
        cur = f.parent_id if f else None
    return False


@folders_router.get("")
def list_folders(user: CurrentUser, db: DbDep) -> list[dict]:
    rows = db.scalars(select(PlanFolder).order_by(PlanFolder.ordering, PlanFolder.name))
    return [_folder_out(f) for f in rows]


@folders_router.post("", status_code=status.HTTP_201_CREATED)
def create_folder(body: FolderIn, user: CurrentUser, db: DbDep) -> dict:
    if body.parent_id is not None and db.get(PlanFolder, body.parent_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Übergeordneter Ordner nicht gefunden")
    nxt = db.scalar(select(func.coalesce(func.max(PlanFolder.ordering), -1)))
    f = PlanFolder(
        name=(body.name or "").strip() or "Ordner",
        parent_id=body.parent_id,
        ordering=int(nxt) + 1,
        created_by=user.id,
    )
    db.add(f)
    db.commit()
    return _folder_out(f)


@folders_router.patch("/{folder_id}")
def patch_folder(folder_id: str, body: FolderPatchIn, user: CurrentUser, db: DbDep) -> dict:
    f = db.get(PlanFolder, folder_id)
    if f is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    if body.name is not None and body.name.strip():
        f.name = body.name.strip()
    if body.parent_id is not None:
        if body.parent_id == folder_id or _is_descendant(db, body.parent_id, folder_id):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Zyklus im Ordnerbaum")
        if db.get(PlanFolder, body.parent_id) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Zielordner nicht gefunden")
        f.parent_id = body.parent_id
    elif body.move_to_root:
        f.parent_id = None
    if body.ordering is not None:
        f.ordering = body.ordering
    db.commit()
    return _folder_out(f)


@folders_router.delete("/{folder_id}")
def delete_folder(folder_id: str, user: CurrentUser, db: DbDep) -> dict:
    f = db.get(PlanFolder, folder_id)
    if f is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    # Inhalt eine Ebene nach oben ziehen, dann Ordner entfernen
    db.execute(update(Plan).where(Plan.folder_id == folder_id).values(folder_id=f.parent_id))
    db.execute(
        update(PlanFolder).where(PlanFolder.parent_id == folder_id).values(parent_id=f.parent_id)
    )
    db.delete(f)
    db.commit()
    return {"ok": True}


@router.delete("/{plan_id}")
def delete_plan(plan: OwnerPlan, request: Request, user: CurrentUser, db: DbDep) -> None:
    plan.deleted_at = now()
    db.commit()
    audit.record(db, "plan.delete", user_id=user.id, target_type="plan", target_id=plan.id,
                 request=request, name=plan.name)


_settings = get_settings()


def _thumb_path(plan_id: str):
    d = _settings.uploads_dir / "thumbs"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{plan_id}.png"


@router.put("/{plan_id}/thumbnail")
async def put_thumbnail(plan: EditorPlan, request: Request) -> dict:
    raw = await request.body()
    if len(raw) > 600_000:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Vorschaubild zu groß")
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Kein PNG")
    _thumb_path(plan.id).write_bytes(raw)
    return {"ok": True}


@router.get("/{plan_id}/thumbnail")
def get_thumbnail(plan: ViewerPlan) -> Response:
    p = _thumb_path(plan.id)
    if not p.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    return Response(p.read_bytes(), media_type="image/png", headers={"Cache-Control": "max-age=60"})


@router.get("/{plan_id}/snapshot")
def get_snapshot(plan: ViewerPlan, user: CurrentUser, db: DbDep) -> dict:
    builder = effective_mission_builder(db, user)
    phase_rows = list(db.scalars(select(Phase).where(Phase.plan_id == plan.id).order_by(Phase.ordering)))
    if not phase_rows:  # Altbestand: fehlende Standard-Phase nachziehen
        base = Phase(plan_id=plan.id, name="Base", ordering=0)
        db.add(base)
        db.flush()
        db.add(Phase(plan_id=plan.id, name="Base", ordering=0, plane="builder", parent_id=base.id))
        db.commit()
        phase_rows = list(db.scalars(select(Phase).where(Phase.plan_id == plan.id)))
    if builder:
        _ensure_builder_pairs(db, plan.id)
        phase_rows = list(
            db.scalars(
                select(Phase).where(Phase.plan_id == plan.id).order_by(Phase.ordering, Phase.sub_ordering)
            )
        )
    phases = [p for p in phase_rows if builder or (p.plane or "player") == "player"]
    layers = db.scalars(select(Layer).where(Layer.plan_id == plan.id).order_by(Layer.ordering))
    from ..models import Map

    mp = db.get(Map, plan.map_id)
    snap = _snapshot(db, plan, include_builder=builder)
    # Ersteller-Namen für die Marker-Anzeige (Hover) anreichern – nur hier,
    # nicht in _snapshot (dessen Output wird für Versionen/Klonen als Marker-kwargs
    # wiederverwendet).
    mk_rows = list(db.scalars(select(Marker).where(Marker.plan_id == plan.id)))
    uids = {m.created_by for m in mk_rows if m.created_by}
    names = (
        {u.id: u.username for u in db.scalars(select(User).where(User.id.in_(uids)))}
        if uids else {}
    )
    by_id = {m.id: m for m in mk_rows}
    for md in snap["markers"]:
        src = by_id.get(md["id"])
        md["author"] = names.get(src.created_by or "") if src else None
    if not builder:
        snap["markers"].extend(released_markers(db, plan.id))
    return {
        "plan": PlanOut.model_validate(plan).model_dump(mode="json"),
        "map_meta": mp.meta if mp else {},
        "phases": [
            {"id": p.id, "name": p.name, "ordering": p.ordering, "notes": p.notes or "",
             "plane": p.plane or "player", "parent_id": p.parent_id,
             "sub_ordering": p.sub_ordering or 0,
             "start_at": p.start_at.isoformat() if p.start_at else None}
            for p in phases
        ],
        "layers": [
            {"id": ly.id, "name": ly.name, "color": ly.color, "ordering": ly.ordering,
             "group_id": ly.group_id, "is_default": ly.is_default}
            for ly in layers
        ],
        **snap,
    }


# ─── Phasen (Zeitstrahl) ───────────────────────────────────────────────────

class PhaseBody(BaseModel):
    name: str | None = None
    ordering: int | None = None
    notes: str | None = None
    plane: str | None = None       # "builder" für eine Missionsbau-(Zwischen-)Phase
    parent_id: str | None = None   # bei plane="builder": zugehörige Spieler-Phase


def _phase_out(p: Phase) -> dict:
    return {
        "id": p.id, "name": p.name, "ordering": p.ordering, "notes": p.notes or "",
        "plane": p.plane or "player", "parent_id": p.parent_id, "sub_ordering": p.sub_ordering or 0,
    }


def _ensure_builder_pairs(db: Session, plan_id: str) -> None:
    """Für jede Spieler-Phase ohne Builder-Gegenstück eine anlegen (Altbestand)."""
    players = list(db.scalars(select(Phase).where(Phase.plan_id == plan_id, Phase.plane == "player")))
    have_parents = set(
        db.scalars(select(Phase.parent_id).where(Phase.plan_id == plan_id, Phase.plane == "builder"))
    )
    made = False
    for pp in players:
        if pp.id not in have_parents:
            db.add(Phase(plan_id=plan_id, name=pp.name, ordering=pp.ordering,
                         plane="builder", parent_id=pp.id))
            made = True
    if made:
        db.commit()


@router.get("/{plan_id}/phases")
def list_phases(plan: ViewerPlan, user: CurrentUser, db: DbDep) -> list[dict]:
    builder = effective_mission_builder(db, user)
    if builder:
        _ensure_builder_pairs(db, plan.id)
    q = select(Phase).where(Phase.plan_id == plan.id).order_by(Phase.ordering, Phase.sub_ordering)
    if not builder:
        q = q.where(Phase.plane == "player")
    return [_phase_out(p) for p in db.scalars(q)]


@router.post("/{plan_id}/phases", status_code=status.HTTP_201_CREATED)
def create_phase(body: PhaseBody, plan: EditorPlan, user: CurrentUser, db: DbDep) -> dict:
    name = (body.name or "").strip() or "Phase"

    # Missionsbau-Zwischenphase (1.1, 1.2 …) unter einer Spieler-Phase
    if body.plane == "builder" and body.parent_id:
        if not effective_mission_builder(db, user):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Missionsbau-Rolle erforderlich")
        parent = db.get(Phase, body.parent_id)
        if parent is None or parent.plan_id != plan.id or parent.plane != "player":
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Spieler-Phase nicht gefunden")
        nsub = db.scalar(
            select(func.coalesce(func.max(Phase.sub_ordering), -1)).where(Phase.parent_id == parent.id)
        )
        p = Phase(plan_id=plan.id, name=name, ordering=parent.ordering, plane="builder",
                  parent_id=parent.id, sub_ordering=int(nsub) + 1)
        db.add(p)
        db.commit()
        return _phase_out(p)

    # normale Spieler-Phase + automatisch gepaarte Builder-Phase
    nxt = db.scalar(
        select(func.coalesce(func.max(Phase.ordering), -1)).where(Phase.plan_id == plan.id)
    )
    p = Phase(plan_id=plan.id, name=name, ordering=int(nxt) + 1)
    db.add(p)
    db.flush()
    db.add(Phase(plan_id=plan.id, name=name, ordering=p.ordering, plane="builder", parent_id=p.id))
    db.commit()
    return _phase_out(p)


@router.patch("/{plan_id}/phases/{phase_id}")
def patch_phase(phase_id: str, body: PhaseBody, plan: EditorPlan, user: CurrentUser, db: DbDep) -> dict:
    p = db.get(Phase, phase_id)
    if p is None or p.plan_id != plan.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    if p.plane == "builder" and not effective_mission_builder(db, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN)
    if body.name is not None and body.name.strip():
        p.name = body.name.strip()
    if body.ordering is not None:
        p.ordering = body.ordering
    if body.notes is not None:
        p.notes = body.notes
    db.commit()
    return _phase_out(p)


@router.delete("/{plan_id}/phases/{phase_id}")
def delete_phase(phase_id: str, plan: EditorPlan, user: CurrentUser, db: DbDep) -> dict:
    p = db.get(Phase, phase_id)
    if p is None or p.plan_id != plan.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    if p.plane == "builder" and not effective_mission_builder(db, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN)
    victims = [p.id]
    if p.plane == "player":  # Spieler-Phase löschen → alle Builder-Kinder mit
        victims += list(db.scalars(select(Phase.id).where(Phase.parent_id == p.id)))
    for vid in victims:
        db.execute(update(Marker).where(Marker.phase_id == vid).values(phase_id=None))
        db.execute(update(Stroke).where(Stroke.phase_id == vid).values(phase_id=None))
        db.execute(update(Annotation).where(Annotation.phase_id == vid).values(phase_id=None))
    db.execute(sa_delete(Phase).where(Phase.id.in_(victims)))
    db.commit()
    return {"ok": True}


# ─── ACL ───────────────────────────────────────────────────────────────────

@router.get("/{plan_id}/acl", response_model=list[ACLOut])
def get_acl(plan: OwnerPlan, db: DbDep) -> list[PlanACL]:
    return list(db.scalars(select(PlanACL).where(PlanACL.plan_id == plan.id)))


@router.get("/{plan_id}/acl/candidates", response_model=list[ACLCandidate])
def acl_candidates(plan: OwnerPlan, db: DbDep) -> list[ACLCandidate]:
    """User + Gruppen, die als ACL-Subjekt gewählt werden können (nur für Plan-Owner)."""
    from ..models import Group, User

    out = [
        ACLCandidate(subject_type="user", subject_id=u.id, name=u.username)
        for u in db.scalars(select(User).where(User.is_active.is_(True)).order_by(User.username))
    ]
    out += [
        ACLCandidate(subject_type="group", subject_id=g.id, name=f"Gruppe: {g.name}")
        for g in db.scalars(select(Group).order_by(Group.name))
    ]
    return out


@router.put("/{plan_id}/acl", response_model=list[ACLOut])
def put_acl(
    entries: list[ACLEntryIn], request: Request, plan: OwnerPlan, user: CurrentUser, db: DbDep
) -> list[PlanACL]:
    if not any(e.level == "owner" for e in entries):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Mindestens ein 'owner' erforderlich")
    db.query(PlanACL).filter(PlanACL.plan_id == plan.id).delete()
    rows = [
        PlanACL(
            plan_id=plan.id, subject_type=e.subject_type, subject_id=e.subject_id, level=e.level,
            can_place=e.can_place, can_move=e.can_move, can_delete=e.can_delete, can_draw=e.can_draw,
        )
        for e in entries
    ]
    db.add_all(rows)
    db.commit()
    audit.record(db, "plan.acl", user_id=user.id, target_type="plan", target_id=plan.id,
                 request=request, entries=len(rows))
    return rows


# ─── Öffentliche Freigaben ─────────────────────────────────────────────────

@router.get("/{plan_id}/shares")
def list_shares(plan: OwnerPlan, db: DbDep) -> list[dict]:
    from ..models import PublicShare

    rows = db.scalars(select(PublicShare).where(PublicShare.plan_id == plan.id))
    return [
        {
            "token": s.token, "label": s.label, "revoked": s.revoked,
            "created_at": s.created_at.isoformat(),
            "expires_at": s.expires_at.isoformat() if s.expires_at else None,
        }
        for s in rows
    ]


@router.post("/{plan_id}/shares", status_code=status.HTTP_201_CREATED)
def create_share(
    body: dict, request: Request, plan: OwnerPlan, user: CurrentUser, db: DbDep
) -> dict:
    import secrets
    from datetime import timedelta

    from ..models import PublicShare, now

    token = secrets.token_urlsafe(24)
    expires = None
    days = body.get("expires_days")
    if isinstance(days, (int, float)) and days > 0:
        expires = now() + timedelta(days=int(days))
    db.add(PublicShare(token=token, plan_id=plan.id, created_by=user.id,
                       label=str(body.get("label") or ""), expires_at=expires))
    db.commit()
    audit.record(db, "plan.share.create", user_id=user.id, target_type="plan", target_id=plan.id,
                 request=request)
    return {"token": token}


@router.delete("/{plan_id}/shares/{token}")
def revoke_share(token: str, request: Request, plan: OwnerPlan, user: CurrentUser, db: DbDep) -> dict:
    from ..models import PublicShare

    s = db.get(PublicShare, token)
    if s is not None and s.plan_id == plan.id:
        s.revoked = True
        db.commit()
        audit.record(db, "plan.share.revoke", user_id=user.id, target_type="plan",
                     target_id=plan.id, request=request)
    return {"ok": True}


# ─── Klonen ────────────────────────────────────────────────────────────────

@router.post("/{plan_id}/clone", response_model=PlanOut, status_code=status.HTTP_201_CREATED)
def clone_plan(
    body: PlanCloneIn, request: Request, plan: ViewerPlan, user: CurrentUser, db: DbDep
) -> Plan:
    if not can_create_plans(db, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Keine Berechtigung, Pläne zu erstellen")
    if body.folder_id is not None and db.get(PlanFolder, body.folder_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ordner nicht gefunden")
    clone = Plan(name=body.name, map_id=plan.map_id, folder_id=body.folder_id, created_by=user.id)
    db.add(clone)
    db.flush()

    phase_map: dict[str, str] = {}
    src_phases = list(db.scalars(select(Phase).where(Phase.plan_id == plan.id)))
    # Spieler-Phasen zuerst klonen, damit die parent_id der Builder-Phasen gemappt werden kann
    for p in sorted(src_phases, key=lambda x: 0 if (x.plane or "player") == "player" else 1):
        np = Phase(
            plan_id=clone.id, name=p.name, ordering=p.ordering, start_at=p.start_at, notes=p.notes,
            plane=p.plane or "player", sub_ordering=p.sub_ordering or 0,
            parent_id=phase_map.get(p.parent_id or ""),
        )
        db.add(np)
        db.flush()
        phase_map[p.id] = np.id

    layer_map: dict[str, str] = {}
    for ly in db.scalars(select(Layer).where(Layer.plan_id == plan.id)):
        nl = Layer(plan_id=clone.id, name=ly.name, color=ly.color, ordering=ly.ordering,
                   group_id=ly.group_id, is_default=ly.is_default)
        db.add(nl)
        db.flush()
        layer_map[ly.id] = nl.id
    if not layer_map:
        db.add(Layer(plan_id=clone.id, name="Allgemein", is_default=True))

    for m in db.scalars(select(Marker).where(Marker.plan_id == plan.id)):
        d = _marker_dict(m)
        d.pop("id")
        d["phase_id"] = phase_map.get(m.phase_id or "")
        d["layer_id"] = layer_map.get(m.layer_id or "")
        db.add(Marker(plan_id=clone.id, created_by=user.id, **d))

    for s in db.scalars(select(Stroke).where(Stroke.plan_id == plan.id)):
        d = _stroke_dict(s)
        d.pop("id")
        d["phase_id"] = phase_map.get(s.phase_id or "")
        d["layer_id"] = layer_map.get(s.layer_id or "")
        db.add(Stroke(plan_id=clone.id, created_by=user.id, **d))

    db.add(PlanACL(plan_id=clone.id, subject_type="user", subject_id=user.id, level="owner"))
    if body.copy_acl:
        for e in db.scalars(select(PlanACL).where(PlanACL.plan_id == plan.id)):
            if not (e.subject_type == "user" and e.subject_id == user.id):
                db.add(PlanACL(plan_id=clone.id, subject_type=e.subject_type,
                               subject_id=e.subject_id, level=e.level))
    db.commit()
    audit.record(db, "plan.clone", user_id=user.id, target_type="plan", target_id=clone.id,
                 request=request, source=plan.id, name=body.name)
    return clone


# ─── Versionen ─────────────────────────────────────────────────────────────

@router.get("/{plan_id}/versions")
def list_versions(plan: ViewerPlan, db: DbDep) -> list[dict]:
    rows = list(
        db.scalars(
            select(PlanVersion)
            .where(PlanVersion.plan_id == plan.id)
            .order_by(PlanVersion.created_at.desc())
        )
    )
    names = {
        u.id: u.username
        for u in db.scalars(select(User).where(User.id.in_({v.created_by for v in rows if v.created_by})))
    }
    out = []
    for v in rows:
        snap = v.snapshot or {}
        out.append(
            {
                "id": v.id,
                "label": v.label,
                "created_at": v.created_at.isoformat(),
                "author": names.get(v.created_by or "", "?"),
                "marker_count": len(snap.get("markers", [])),
                "stroke_count": len(snap.get("strokes", [])),
            }
        )
    return out


@router.post("/{plan_id}/versions", status_code=status.HTTP_201_CREATED)
def create_version(body: VersionCreateIn, plan: EditorPlan, user: CurrentUser, db: DbDep) -> dict:
    v = PlanVersion(plan_id=plan.id, label=body.label, snapshot=_snapshot(db, plan), created_by=user.id)
    db.add(v)
    db.commit()
    return {"id": v.id}


@router.post("/{plan_id}/restore/{version_id}")
def restore_version(version_id: str, plan: OwnerPlan, user: CurrentUser, db: DbDep) -> None:
    v = db.get(PlanVersion, version_id)
    if v is None or v.plan_id != plan.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    # Sicherungs-Version des aktuellen Stands vor dem Zurücksetzen
    db.add(
        PlanVersion(
            plan_id=plan.id,
            label=f"vor Wiederherstellung ({v.label or v.created_at.strftime('%d.%m. %H:%M')})",
            snapshot=_snapshot(db, plan),
            created_by=user.id,
        )
    )
    db.query(Marker).filter(Marker.plan_id == plan.id).delete()
    db.query(Stroke).filter(Stroke.plan_id == plan.id).delete()
    for md in v.snapshot.get("markers", []):
        db.add(Marker(plan_id=plan.id, **{k: md[k] for k in md if k != "id"}))
    for sd in v.snapshot.get("strokes", []):
        db.add(Stroke(plan_id=plan.id, **{k: sd[k] for k in sd if k != "id"}))
    plan.updated_at = now()
    db.commit()
