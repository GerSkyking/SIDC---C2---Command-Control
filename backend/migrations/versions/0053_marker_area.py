"""markers.area – Bereich (Linie/Fläche) um einen Marker

Revision ID: 0053_marker_area
Revises: 0052_stroke_fill_style
Create Date: 2026-11-15
"""
import sqlalchemy as sa
from alembic import op

revision = "0053_marker_area"
down_revision = "0052_stroke_fill_style"
branch_labels = None
depends_on = None


def upgrade() -> None:
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("markers")}
    if "area" not in cols:
        with op.batch_alter_table("markers") as b:
            b.add_column(sa.Column("area", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("markers") as b:
        b.drop_column("area")
