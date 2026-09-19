"""phase.locked – die initiale "Base"-Spielerphase ist ab jetzt gegen Löschen
gesperrt; ihre gepaarte Missionsbau-Phase wird dadurch für ALLE sichtbar
(weiterhin nur von Missionsbauern bearbeitbar). Bestehende Pläne: die jeweils
erste Spielerphase (kleinste ordering) wird nachträglich gesperrt.

Revision ID: 0020_phase_locked
Revises: 0019_image_placements
Create Date: 2026-09-19
"""
import sqlalchemy as sa
from alembic import op

revision = "0020_phase_locked"
down_revision = "0019_image_placements"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if not insp.has_table("phases"):
        return
    cols = {c["name"] for c in insp.get_columns("phases")}
    if "locked" not in cols:
        with op.batch_alter_table("phases") as batch_op:
            batch_op.add_column(sa.Column("locked", sa.Boolean(), nullable=False, server_default=sa.false()))

    # Je Plan die erste Spielerphase (kleinste ordering) nachträglich sperren.
    rows = bind.execute(
        sa.text("SELECT id, plan_id FROM phases WHERE plane = 'player' ORDER BY plan_id, ordering, id")
    ).fetchall()
    seen: set[str] = set()
    locked_ids: list[str] = []
    for r in rows:
        if r.plan_id in seen:
            continue
        seen.add(r.plan_id)
        locked_ids.append(r.id)
        bind.execute(sa.text("UPDATE phases SET locked = :t WHERE id = :id"), {"t": True, "id": r.id})

    # Ihre gepaarte Missionsbau-Phase gleich mit sperren (sonst könnte die
    # Kopplung, die die Sichtbarkeit für alle herstellt, gelöscht werden).
    if locked_ids:
        bind.execute(
            sa.text(
                "UPDATE phases SET locked = :t WHERE plane = 'builder' AND parent_id IN "
                f"({','.join(':p' + str(i) for i in range(len(locked_ids)))})"
            ),
            {"t": True, **{f"p{i}": v for i, v in enumerate(locked_ids)}},
        )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if insp.has_table("phases") and "locked" in {c["name"] for c in insp.get_columns("phases")}:
        with op.batch_alter_table("phases") as batch_op:
            batch_op.drop_column("locked")
