"""ORBAT-Bibliothek: globale Kräfteübersichten mit Baumstruktur + eigener ACL.

Bearbeiten setzt die Missionsbau-Rolle **und** ORBAT-``editor`` (oder Ersteller/Admin)
voraus. Lesen: ORBAT-``viewer`` (oder Ersteller/Admin). Die für Spieler „freigegebene"
Sicht auf ein ORBAT (Baustein C) wird separat gefiltert.
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Request, status
from pydantic import BaseModel
from sqlalchemy import delete as sa_delete
from sqlalchemy import select

from .. import audit
from ..deps import CurrentUser, DbDep
from ..models import GroupMember, Marker, Orbat, OrbatACL, OrbatNode, Plan, PlanOrbat
from ..permissions import effective_level, effective_mission_builder, rank
from ..services.realtime import hub
from ..sidc_status import sidc_with_affiliation, sidc_with_status

router = APIRouter(prefix="/api/orbats", tags=["orbat"])
plan_orbat_router = APIRouter(prefix="/plans/{plan_id}/orbats", tags=["orbat"])

_AFFIL = {"friend", "hostile", "neutral", "unknown"}
_STATUS = {"active", "damaged", "destroyed"}


# ─── Rechte ────────────────────────────────────────────────────────────────

def _subjects(db, user) -> set[tuple[str, str]]:
    gids = db.scalars(select(GroupMember.group_id).where(GroupMember.user_id == user.id))
    return {("user", user.id), *(("group", g) for g in gids)}


def _acl_level(db, user, orbat: Orbat) -> str | None:
    if user.is_admin or orbat.created_by == user.id:
        return "editor"
    subs = _subjects(db, user)
    best: str | None = None
    for a in db.scalars(select(OrbatACL).where(OrbatACL.orbat_id == orbat.id)):
        if (a.subject_type, a.subject_id) in subs:
            if a.level == "editor":
                return "editor"
            best = best or "viewer"
    return best


def _load(orbat_id: str, db, user, need: str) -> Orbat:
    o = db.get(Orbat, orbat_id)
    if o is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    lvl = _acl_level(db, user, o)
    if lvl is None or (need == "editor" and lvl != "editor"):
        raise HTTPException(status.HTTP_403_FORBIDDEN)
    if need == "editor" and not effective_mission_builder(db, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Missionsbau-Rolle erforderlich")
    return o


def _is_owner(db, user, o: Orbat) -> bool:
    return user.is_admin or o.created_by == user.id


# ─── Schemas ───────────────────────────────────────────────────────────────

class OrbatIn(BaseModel):
    name: str
    affiliation: str = "own"
    notes: str = ""


class OrbatPatch(BaseModel):
    name: str | None = None
    affiliation: str | None = None
    notes: str | None = None


class NodeIn(BaseModel):
    name: str = "Einheit"
    sidc: str = ""
    parent_id: str | None = None
    qty_planned: int = 1
    qty_current: int | None = None
    status: str = "active"
    ordering: int | None = None
    notes: str = ""
    rel_visible: bool = False
    rel_show_type: bool = False
    rel_strength: int = 50


class NodePatch(BaseModel):
    name: str | None = None
    sidc: str | None = None
    parent_id: str | None = None
    qty_planned: int | None = None
    qty_current: int | None = None
    status: str | None = None
    ordering: int | None = None
    notes: str | None = None
    rel_visible: bool | None = None
    rel_show_type: bool | None = None
    rel_strength: int | None = None


def _node_out(n: OrbatNode) -> dict:
    return {
        "id": n.id, "parent_id": n.parent_id, "name": n.name, "sidc": n.sidc,
        "qty_planned": n.qty_planned, "qty_current": n.qty_current, "status": n.status,
        "ordering": n.ordering, "notes": n.notes or "",
        "rel_visible": n.rel_visible, "rel_show_type": n.rel_show_type, "rel_strength": n.rel_strength,
    }


def _orbat_out(db, user, o: Orbat, with_nodes: bool = False) -> dict:
    d = {
        "id": o.id, "name": o.name, "affiliation": o.affiliation, "notes": o.notes or "",
        "level": _acl_level(db, user, o), "is_owner": _is_owner(db, user, o),
    }
    if with_nodes:
        d["nodes"] = [
            _node_out(n)
            for n in db.scalars(
                select(OrbatNode).where(OrbatNode.orbat_id == o.id).order_by(OrbatNode.ordering)
            )
        ]
    return d


# ─── ORBAT-CRUD ────────────────────────────────────────────────────────────

@router.get("")
def list_orbats(user: CurrentUser, db: DbDep) -> list[dict]:
    if not effective_mission_builder(db, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Missionsbau-Rolle erforderlich")
    out = []
    for o in db.scalars(select(Orbat).order_by(Orbat.name)):
        if _acl_level(db, user, o) is not None:
            out.append(_orbat_out(db, user, o))
    return out


@router.post("", status_code=status.HTTP_201_CREATED)
def create_orbat(body: OrbatIn, request: Request, user: CurrentUser, db: DbDep) -> dict:
    if not effective_mission_builder(db, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Missionsbau-Rolle erforderlich")
    aff = body.affiliation if body.affiliation in _AFFIL else "friend"
    o = Orbat(name=body.name.strip() or "ORBAT", affiliation=aff, notes=body.notes, created_by=user.id)
    db.add(o)
    db.commit()
    audit.record(db, "orbat.create", user_id=user.id, target_type="orbat", target_id=o.id,
                 request=request, name=o.name)
    return _orbat_out(db, user, o, with_nodes=True)


@router.get("/{orbat_id}")
def get_orbat(orbat_id: str, user: CurrentUser, db: DbDep) -> dict:
    o = _load(orbat_id, db, user, "viewer")
    return _orbat_out(db, user, o, with_nodes=True)


@router.patch("/{orbat_id}")
async def patch_orbat(orbat_id: str, body: OrbatPatch, user: CurrentUser, db: DbDep) -> dict:
    o = _load(orbat_id, db, user, "editor")
    if body.name is not None and body.name.strip():
        o.name = body.name.strip()
    aff_changed = (
        body.affiliation is not None
        and body.affiliation in _AFFIL
        and body.affiliation != o.affiliation
    )
    if aff_changed:
        o.affiliation = body.affiliation
    if body.notes is not None:
        o.notes = body.notes
    db.commit()
    if aff_changed:
        await _propagate_affiliation(db, o)
    return _orbat_out(db, user, o, with_nodes=True)


async def _propagate_affiliation(db, o: Orbat) -> None:
    """ORBAT-Zugehörigkeit → Identitätsstelle aller Knoten-SIDC und verknüpften Marker."""
    from .live import _author_of, _marker_out, _phase_is_builder

    nodes = list(db.scalars(select(OrbatNode).where(OrbatNode.orbat_id == o.id)))
    node_ids = [n.id for n in nodes]
    for n in nodes:
        if n.sidc:
            n.sidc = sidc_with_affiliation(n.sidc, o.affiliation)
    touched: list[Marker] = []
    if node_ids:
        for m in db.scalars(select(Marker).where(Marker.orbat_node_id.in_(node_ids))):
            new_sidc = sidc_with_affiliation(m.sidc, o.affiliation)
            if new_sidc != m.sidc:
                m.sidc = new_sidc
                touched.append(m)
    db.commit()
    for m in touched:
        await hub.broadcast(
            m.plan_id, {"type": "marker.upsert", "marker": _marker_out(m, _author_of(db, m))},
            builder_only=_phase_is_builder(m.plan_id, m.phase_id),
        )


@router.delete("/{orbat_id}")
def delete_orbat(orbat_id: str, request: Request, user: CurrentUser, db: DbDep) -> dict:
    o = db.get(Orbat, orbat_id)
    if o is None:
        return {"ok": True}
    if not _is_owner(db, user, o):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Nur Ersteller/Admin")
    audit.record(db, "orbat.delete", user_id=user.id, target_type="orbat", target_id=orbat_id,
                 request=request, name=o.name)
    db.delete(o)
    db.commit()
    return {"ok": True}


# ─── Knoten ────────────────────────────────────────────────────────────────

@router.post("/{orbat_id}/nodes", status_code=status.HTTP_201_CREATED)
def create_node(orbat_id: str, body: NodeIn, user: CurrentUser, db: DbDep) -> dict:
    orbat = _load(orbat_id, db, user, "editor")
    if body.parent_id is not None:
        p = db.get(OrbatNode, body.parent_id)
        if p is None or p.orbat_id != orbat_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Eltern-Knoten unbekannt")
    nxt = body.ordering
    if nxt is None:
        siblings = db.scalars(
            select(OrbatNode.ordering).where(
                OrbatNode.orbat_id == orbat_id,
                OrbatNode.parent_id.is_(body.parent_id) if body.parent_id is None
                else OrbatNode.parent_id == body.parent_id,
            )
        )
        nxt = (max(list(siblings), default=-1) + 1)
    n = OrbatNode(
        orbat_id=orbat_id, parent_id=body.parent_id, name=body.name.strip() or "Einheit",
        sidc=sidc_with_affiliation(body.sidc, orbat.affiliation) if body.sidc else "",
        qty_planned=max(0, body.qty_planned),
        qty_current=body.qty_current if body.qty_current is not None else max(0, body.qty_planned),
        status=body.status if body.status in _STATUS else "active", ordering=nxt, notes=body.notes,
        rel_visible=body.rel_visible, rel_show_type=body.rel_show_type,
        rel_strength=max(-1, min(100, body.rel_strength)),
    )
    db.add(n)
    db.commit()
    return _node_out(n)


@router.patch("/{orbat_id}/nodes/{node_id}")
async def patch_node(
    orbat_id: str, node_id: str, body: NodePatch, user: CurrentUser, db: DbDep
) -> dict:
    _load(orbat_id, db, user, "editor")
    n = db.get(OrbatNode, node_id)
    if n is None or n.orbat_id != orbat_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    data = body.model_dump(exclude_unset=True)
    if "parent_id" in data and data["parent_id"] == node_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Knoten kann nicht sein eigenes Elter sein")
    if data.get("status") and data["status"] not in _STATUS:
        data.pop("status")
    if "rel_strength" in data and data["rel_strength"] is not None:
        data["rel_strength"] = max(-1, min(100, data["rel_strength"]))
    if data.get("sidc"):
        data["sidc"] = sidc_with_affiliation(data["sidc"], db.get(Orbat, orbat_id).affiliation)
    status_changed = "status" in data and data["status"] != n.status
    for k, v in data.items():
        setattr(n, k, v)
    db.commit()
    if status_changed:
        await _propagate_node_status(db, n)
    return _node_out(n)


async def _propagate_node_status(db, n: OrbatNode) -> None:
    """Knoten-Status → SIDC-Statusstelle aller verknüpften Marker; live an alle
    Pläne, in denen das ORBAT hängt."""
    from .live import _phase_is_builder, _marker_out, _author_of

    linked = list(db.scalars(select(Marker).where(Marker.orbat_node_id == n.id)))
    if not linked:
        return
    touched: list[Marker] = []
    for m in linked:
        new_sidc = sidc_with_status(m.sidc, n.status)
        if new_sidc != m.sidc:
            m.sidc = new_sidc
            touched.append(m)
    if touched:
        db.commit()
    for m in touched:
        await hub.broadcast(
            m.plan_id, {"type": "marker.upsert", "marker": _marker_out(m, _author_of(db, m))},
            builder_only=_phase_is_builder(m.plan_id, m.phase_id),
        )


@router.delete("/{orbat_id}/nodes/{node_id}")
def delete_node(orbat_id: str, node_id: str, user: CurrentUser, db: DbDep) -> dict:
    _load(orbat_id, db, user, "editor")
    n = db.get(OrbatNode, node_id)
    if n is not None and n.orbat_id == orbat_id:
        db.delete(n)  # CASCADE räumt Kinder
        db.commit()
    return {"ok": True}


# ─── ACL ───────────────────────────────────────────────────────────────────

class OrbatACLEntry(BaseModel):
    subject_type: str
    subject_id: str
    level: str = "viewer"
    can_place: bool = True
    can_move: bool = True


@router.get("/{orbat_id}/acl")
def get_orbat_acl(orbat_id: str, user: CurrentUser, db: DbDep) -> dict:
    o = db.get(Orbat, orbat_id)
    if o is None or not _is_owner(db, user, o):
        raise HTTPException(status.HTTP_403_FORBIDDEN)
    from ..models import Group, User

    return {
        "entries": [
            {"subject_type": a.subject_type, "subject_id": a.subject_id, "level": a.level,
             "can_place": a.can_place, "can_move": a.can_move}
            for a in db.scalars(select(OrbatACL).where(OrbatACL.orbat_id == orbat_id))
        ],
        "candidates": [
            {"subject_type": "user", "subject_id": u.id, "name": u.username}
            for u in db.scalars(select(User).where(User.is_active.is_(True)).order_by(User.username))
        ] + [
            {"subject_type": "group", "subject_id": g.id, "name": f"Gruppe: {g.name}"}
            for g in db.scalars(select(Group).order_by(Group.name))
        ],
    }


@router.put("/{orbat_id}/acl")
def put_orbat_acl(orbat_id: str, entries: list[OrbatACLEntry], user: CurrentUser, db: DbDep) -> dict:
    o = db.get(Orbat, orbat_id)
    if o is None or not _is_owner(db, user, o):
        raise HTTPException(status.HTTP_403_FORBIDDEN)
    db.execute(sa_delete(OrbatACL).where(OrbatACL.orbat_id == orbat_id))
    for e in entries:
        db.add(OrbatACL(
            orbat_id=orbat_id, subject_type=e.subject_type, subject_id=e.subject_id,
            level="editor" if e.level == "editor" else "viewer",
            can_place=e.can_place, can_move=e.can_move,
        ))
    db.commit()
    return get_orbat_acl(orbat_id, user, db)


# ─── ORBAT ↔ Plan ─────────────────────────────────────────────────────────

def _plan_editor(plan_id: str, user, db) -> Plan:
    plan = db.get(Plan, plan_id)
    if plan is None or plan.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    if rank(effective_level(db, user, plan)) < rank("editor"):
        raise HTTPException(status.HTTP_403_FORBIDDEN)
    return plan


@plan_orbat_router.get("")
def list_plan_orbats(plan_id: Annotated[str, Path()], user: CurrentUser, db: DbDep) -> list[dict]:
    plan = db.get(Plan, plan_id)
    if plan is None or plan.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    if effective_level(db, user, plan) is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN)
    mb = effective_mission_builder(db, user)
    ids = list(db.scalars(select(PlanOrbat.orbat_id).where(PlanOrbat.plan_id == plan_id)))
    out = []
    for oid in ids:
        o = db.get(Orbat, oid)
        if o is None:
            continue
        full = mb and _acl_level(db, user, o) is not None
        d = {"id": o.id, "name": o.name, "affiliation": o.affiliation, "released": not full}
        nodes = db.scalars(select(OrbatNode).where(OrbatNode.orbat_id == oid).order_by(OrbatNode.ordering))
        d["nodes"] = [
            _node_out(n) if full else _released_node(n)
            for n in nodes
            if full or n.rel_visible
        ]
        out.append(d)
    return out


def _released_node(n: OrbatNode) -> dict:
    """Für Spieler reduzierte Sicht gemäß Freigabe."""
    strength: int | None
    if n.rel_strength < 0:
        strength = None
    else:
        strength = round(n.qty_planned * n.rel_strength / 100)
    return {
        "id": n.id, "parent_id": n.parent_id,
        "name": n.name if n.rel_show_type else "?",
        "sidc": n.sidc if n.rel_show_type else "",
        "qty_planned": strength, "qty_current": None,
        "status": n.status, "ordering": n.ordering, "notes": "",
        "released": True,
    }


@plan_orbat_router.post("", status_code=status.HTTP_201_CREATED)
def add_plan_orbat(plan_id: Annotated[str, Path()], body: dict, user: CurrentUser, db: DbDep) -> dict:
    _plan_editor(plan_id, user, db)
    oid = str(body.get("orbat_id") or "")
    o = db.get(Orbat, oid)
    if o is None or _acl_level(db, user, o) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "ORBAT unbekannt")
    if db.get(PlanOrbat, (plan_id, oid)) is None:
        db.add(PlanOrbat(plan_id=plan_id, orbat_id=oid, added_by=user.id))
        db.commit()
    return {"ok": True}


@plan_orbat_router.delete("/{orbat_id}")
def remove_plan_orbat(
    plan_id: Annotated[str, Path()], orbat_id: str, user: CurrentUser, db: DbDep
) -> dict:
    _plan_editor(plan_id, user, db)
    link = db.get(PlanOrbat, (plan_id, orbat_id))
    if link is not None:
        db.delete(link)
        db.commit()
    return {"ok": True}
