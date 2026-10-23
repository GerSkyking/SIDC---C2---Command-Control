"""Linien in mehreren Phasen: strokes.extra_phase_ids

Revision ID: 0026_stroke_extra_phases
Revises: 0025_player_released
Create Date: 2026-10-23
"""
import sqlalchemy as sa
from alembic import op

revision = "0026_stroke_extra_phases"
down_revision = "0025_player_released"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if insp.has_table("strokes") and "extra_phase_ids" not in {c["name"] for c in insp.get_columns("strokes")}:
        with op.batch_alter_table("strokes") as b:
            b.add_column(sa.Column("extra_phase_ids", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("strokes") as b:
        b.drop_column("extra_phase_ids")
