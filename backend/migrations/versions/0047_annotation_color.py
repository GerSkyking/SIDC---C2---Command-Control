"""Stern-Pins: eigene Farbe (annotations.color)

Revision ID: 0047_annotation_color
Revises: 0046_stroke_area
Create Date: 2026-11-12
"""
import sqlalchemy as sa
from alembic import op

revision = "0047_annotation_color"
down_revision = "0046_stroke_area"
branch_labels = None
depends_on = None


def upgrade() -> None:
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("annotations")}
    if "color" not in cols:
        with op.batch_alter_table("annotations") as b:
            b.add_column(sa.Column("color", sa.String(7), nullable=False, server_default=""))


def downgrade() -> None:
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("annotations")}
    if "color" in cols:
        with op.batch_alter_table("annotations") as b:
            b.drop_column("color")
