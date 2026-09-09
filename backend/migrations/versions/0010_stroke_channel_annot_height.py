"""Stroke: channel-Spalte; Annotation: height-Spalte

Revision ID: 0010_stroke_channel_annot_height
Revises: 0009_marker_scale
Create Date: 2026-09-09
"""
import sqlalchemy as sa
from alembic import op

revision = "0010_stroke_channel_annot_height"
down_revision = "0009_marker_scale"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if insp.has_table("strokes") and "channel" not in {c["name"] for c in insp.get_columns("strokes")}:
        op.add_column("strokes", sa.Column("channel", sa.String(length=64), nullable=False, server_default=""))
    if insp.has_table("annotations") and "height" not in {c["name"] for c in insp.get_columns("annotations")}:
        op.add_column("annotations", sa.Column("height", sa.Float(), nullable=False, server_default="0"))


def downgrade() -> None:
    op.drop_column("strokes", "channel")
    op.drop_column("annotations", "height")
