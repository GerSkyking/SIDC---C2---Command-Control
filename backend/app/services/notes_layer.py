"""Feste Missionsbau-Ebene "Karten-Notizen" in Projekt-Plänen.

Jede Annotation (Textfeld/Verweis-Pin) eines Plans mit ``project_id`` liegt auf der Phase mit
``role == "notes"``: Ebene ``builder`` (Spieler sehen sie nie). Zeus sieht sie erst, wenn ein
Missionsbauer sie freigibt (``zeus_released``, wie jede Builder-Phase). ``parent_id`` bleibt
leer — eine an die gesperrte Base-Phase gehängte Builder-Phase wäre sonst die für ALLE sichtbare
"Spiegel"-Phase. Committet nicht (läuft in der Transaktion des Aufrufers).
"""
from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Phase, Plan

NOTES_ROLE = "notes"
NOTES_NAME = "Karten-Notizen"


def get_notes_phase(db: Session, plan_id: str) -> Phase | None:
    return db.scalars(
        select(Phase).where(Phase.plan_id == plan_id, Phase.role == NOTES_ROLE)
        .order_by(Phase.created_at, Phase.id).limit(1)
    ).first()


def ensure_notes_phase(db: Session, plan: Plan) -> Phase:
    """Notes-Phase des Plans (idempotent); legt sie an, falls noch nicht vorhanden."""
    p = get_notes_phase(db, plan.id)
    if p is not None:
        return p
    top = db.scalar(select(func.max(Phase.ordering)).where(Phase.plan_id == plan.id))
    p = Phase(
        plan_id=plan.id, name=NOTES_NAME, ordering=(top if top is not None else -1) + 1,
        plane="builder", role=NOTES_ROLE, zeus_released=False, zeus_until=None, player_released=False,
    )
    db.add(p)
    db.flush()
    return p


def release_notes_role(db: Session, plan: Plan) -> None:
    """Plan verlässt das Projekt: die Phase bleibt (samt Inhalt), verliert aber den Schutz."""
    for p in db.scalars(select(Phase).where(Phase.plan_id == plan.id, Phase.role == NOTES_ROLE)):
        p.role = None
