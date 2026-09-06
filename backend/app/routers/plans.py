"""Plan-Lebenszyklus: CRUD, ACL, Klonen, Versionen, Snapshot-Laden."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import audit

from ..deps import CurrentUser, DbDep, load_plan, require_plan_level
from ..models import (
    Layer,
    Marker,
    Phase,
    Plan,
    PlanACL,
    PlanVersion,
    Stroke,
    User,
    now,
)
from ..permissions import can_create_plans, effective_level
from ..schemas import (
    ACLCandidate,
    ACLEntryIn,
    ACLOut,
    PlanCloneIn,
    PlanCreateIn,
    PlanListItem,
    PlanOut,
    PlanPatchIn,
    VersionCreateIn,
)

router = APIRouter(prefix="/plans", tags=["plans"])

EditorPlan = Annotated[Plan, Depends(require_plan_level("editor"))]
OwnerPlan = Annotated[Plan, Depends(require_plan_level("owner"))]
ViewerPlan = Annotated[Plan, Depends(require_plan_level("viewer"))]


def _snapshot(db: Session, plan: Plan) -> dict:
    markers = db.scalars(select(Marker).where(Marker.plan_id == plan.id))
    strokes = db.scalars(select(Stroke).where(Stroke.plan_id == plan.id))
    return {
        "markers": [_marker_dict(m) for m in markers],
        "strokes": [_stroke_dict(s) for s in strokes],
    }


def _marker_dict(m: Marker) -> dict:
    return {
        "id": m.id, "phase_id": m.phase_id, "layer_id": m.layer_id, "sidc": m.sidc,
        "world_x": m.world_x, "world_y": m.world_y, "rotation_degrees": m.rotation_degrees, "icon_rotation": m.icon_rotation,
        "unit_text": m.unit_text, "ai_text": m.ai_text, "channel": m.channel,
        "locked": m.locked, "timestamp_visible": m.timestamp_visible,
        "linked_group_id": m.linked_group_id, "point_index": m.point_index,
        "line_color": m.line_color, "line_width": m.line_width,
    }


def _stroke_dict(s: Stroke) -> dict:
    return {
        "id": s.id, "phase_id": s.phase_id, "layer_id": s.layer_id, "kind": s.kind,
        "points": s.points, "color": s.color, "width": s.width,
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


@router.post("", response_model=PlanOut, status_code=status.HTTP_201_CREATED)
def create_plan(body: PlanCreateIn, request: Request, user: CurrentUser, db: DbDep) -> Plan:
    if not can_create_plans(db, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Keine Berechtigung, Pläne zu erstellen")
    plan = Plan(name=body.name, map_id=body.map_id, created_by=user.id)
    db.add(plan)
    db.flush()
    db.add(PlanACL(plan_id=plan.id, subject_type="user", subject_id=user.id, level="owner"))
    db.add(Layer(plan_id=plan.id, name="Allgemein", is_default=True))
    db.commit()
    audit.record(db, "plan.create", user_id=user.id, target_type="plan", target_id=plan.id,
                 request=request, name=plan.name, map_id=plan.map_id)
    return plan


@router.get("/{plan_id}", response_model=PlanOut)
def get_plan(plan: ViewerPlan) -> Plan:
    return plan


@router.patch("/{plan_id}", response_model=PlanOut)
def patch_plan(body: PlanPatchIn, plan: OwnerPlan, db: DbDep) -> Plan:
    if body.name is not None:
        plan.name = body.name
    db.commit()
    return plan


@router.delete("/{plan_id}")
def delete_plan(plan: OwnerPlan, request: Request, user: CurrentUser, db: DbDep) -> None:
    plan.deleted_at = now()
    db.commit()
    audit.record(db, "plan.delete", user_id=user.id, target_type="plan", target_id=plan.id,
                 request=request, name=plan.name)


@router.get("/{plan_id}/snapshot")
def get_snapshot(plan: ViewerPlan, db: DbDep) -> dict:
    phases = db.scalars(select(Phase).where(Phase.plan_id == plan.id).order_by(Phase.ordering))
    layers = db.scalars(select(Layer).where(Layer.plan_id == plan.id).order_by(Layer.ordering))
    from ..models import Map

    mp = db.get(Map, plan.map_id)
    return {
        "plan": PlanOut.model_validate(plan).model_dump(mode="json"),
        "map_meta": mp.meta if mp else {},
        "phases": [
            {"id": p.id, "name": p.name, "ordering": p.ordering,
             "start_at": p.start_at.isoformat() if p.start_at else None}
            for p in phases
        ],
        "layers": [
            {"id": ly.id, "name": ly.name, "color": ly.color, "ordering": ly.ordering,
             "group_id": ly.group_id, "is_default": ly.is_default}
            for ly in layers
        ],
        **_snapshot(db, plan),
    }


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


# ─── Klonen ────────────────────────────────────────────────────────────────

@router.post("/{plan_id}/clone", response_model=PlanOut, status_code=status.HTTP_201_CREATED)
def clone_plan(
    body: PlanCloneIn, request: Request, plan: ViewerPlan, user: CurrentUser, db: DbDep
) -> Plan:
    if not can_create_plans(db, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Keine Berechtigung, Pläne zu erstellen")
    clone = Plan(name=body.name, map_id=plan.map_id, created_by=user.id)
    db.add(clone)
    db.flush()

    phase_map: dict[str, str] = {}
    for p in db.scalars(select(Phase).where(Phase.plan_id == plan.id)):
        np = Phase(plan_id=clone.id, name=p.name, ordering=p.ordering, start_at=p.start_at)
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
    rows = db.scalars(
        select(PlanVersion).where(PlanVersion.plan_id == plan.id).order_by(PlanVersion.created_at.desc())
    )
    return [{"id": v.id, "label": v.label, "created_at": v.created_at.isoformat()} for v in rows]


@router.post("/{plan_id}/versions", status_code=status.HTTP_201_CREATED)
def create_version(body: VersionCreateIn, plan: EditorPlan, user: CurrentUser, db: DbDep) -> dict:
    v = PlanVersion(plan_id=plan.id, label=body.label, snapshot=_snapshot(db, plan), created_by=user.id)
    db.add(v)
    db.commit()
    return {"id": v.id}


@router.post("/{plan_id}/restore/{version_id}")
def restore_version(version_id: str, plan: OwnerPlan, db: DbDep) -> None:
    v = db.get(PlanVersion, version_id)
    if v is None or v.plan_id != plan.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    db.query(Marker).filter(Marker.plan_id == plan.id).delete()
    db.query(Stroke).filter(Stroke.plan_id == plan.id).delete()
    for md in v.snapshot.get("markers", []):
        db.add(Marker(plan_id=plan.id, **{k: md[k] for k in md if k != "id"}))
    for sd in v.snapshot.get("strokes", []):
        db.add(Stroke(plan_id=plan.id, **{k: sd[k] for k in sd if k != "id"}))
    plan.updated_at = now()
    db.commit()
