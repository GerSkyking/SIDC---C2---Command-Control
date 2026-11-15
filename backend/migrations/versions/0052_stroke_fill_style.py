"""strokes.fill_pattern / fill_strength – Füllmuster und -stärke von Flächen

Revision ID: 0052_stroke_fill_style
Revises: 0051_plan_deleted_by
Create Date: 2026-11-15
"""
import sqlalchemy as sa
from alembic import op

revision = "0052_stroke_fill_style"
down_revision = "0051_plan_deleted_by"
branch_labels = None
depends_on = None


def upgrade() -> None:
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("strokes")}
    with op.batch_alter_table("strokes") as b:
        if "fill_pattern" not in cols:
            b.add_column(sa.Column("fill_pattern", sa.String(length=8), nullable=False, server_default="diag"))
        if "fill_strength" not in cols:
            b.add_column(sa.Column("fill_strength", sa.Integer(), nullable=False, server_default="25"))


def downgrade() -> None:
    with op.batch_alter_table("strokes") as b:
        b.drop_column("fill_strength")
        b.drop_column("fill_pattern")
