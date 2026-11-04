"""Feste Ebene "Karten-Notizen" in Projekt-Plänen: phases.role + Daten-Migration

Revision ID: 0043_notes_layer
Revises: 0042_project_refs_len
Create Date: 2026-11-04
"""
import uuid
from datetime import datetime, timezone

import sqlalchemy as sa
from alembic import op

revision = "0043_notes_layer"
down_revision = "0042_project_refs_len"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    cols = {c["name"] for c in insp.get_columns("phases")}
    if "role" not in cols:
        with op.batch_alter_table("phases") as batch_op:
            batch_op.add_column(sa.Column("role", sa.String(16), nullable=True))

    # Jeder Plan in einem Projekt bekommt genau eine notes-Ebene (Missionsbau, NICHT für Zeus
    # freigegeben, nicht für Spieler). parent_id bleibt NULL: eine an die gesperrte Base-Phase
    # gehängte Builder-Phase (sub_ordering 0) würde als "Spiegel" für ALLE sichtbar.
    bind = op.get_bind()
    phases = sa.table(
        "phases",
        sa.column("id", sa.String), sa.column("plan_id", sa.String), sa.column("name", sa.String),
        sa.column("ordering", sa.Integer), sa.column("plane", sa.String), sa.column("role", sa.String),
        sa.column("sub_ordering", sa.Integer), sa.column("notes", sa.Text),
        sa.column("locked", sa.Boolean), sa.column("zeus_released", sa.Boolean),
        sa.column("player_released", sa.Boolean), sa.column("created_at", sa.DateTime(timezone=True)),
    )
    plans = sa.table("plans", sa.column("id", sa.String), sa.column("project_id", sa.String))
    have = {r[0] for r in bind.execute(sa.select(phases.c.plan_id).where(phases.c.role == "notes"))}
    t_now = datetime.now(timezone.utc)
    for (plan_id,) in bind.execute(sa.select(plans.c.id).where(plans.c.project_id.is_not(None))).all():
        if plan_id in have:
            continue
        top = bind.execute(sa.select(sa.func.max(phases.c.ordering)).where(phases.c.plan_id == plan_id)).scalar()
        bind.execute(phases.insert().values(
            id=uuid.uuid4().hex, plan_id=plan_id, name="Karten-Notizen", ordering=(top if top is not None else -1) + 1,
            plane="builder", role="notes", sub_ordering=0, notes="", locked=False,
            zeus_released=False, player_released=False, created_at=t_now,
        ))


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    cols = {c["name"] for c in insp.get_columns("phases")}
    if "role" in cols:
        # Die Ebene wird samt Inhalt entfernt (wie beim manuellen Löschen einer Builder-Phase).
        op.execute("DELETE FROM annotations WHERE phase_id IN (SELECT id FROM phases WHERE role = 'notes')")
        op.execute("DELETE FROM phases WHERE role = 'notes'")
        with op.batch_alter_table("phases") as batch_op:
            batch_op.drop_column("role")
