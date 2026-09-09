"""Marker: scale-Spalte (Icon-Größe pro Marker)

Revision ID: 0009_marker_scale
Revises: 0008_favorite_channel
Create Date: 2026-09-09
"""
import sqlalchemy as sa
from alembic import op

revision = "0009_marker_scale"
down_revision = "0008_favorite_channel"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if insp.has_table("markers") and "scale" not in {c["name"] for c in insp.get_columns("markers")}:
        op.add_column("markers", sa.Column("scale", sa.Float(), nullable=False, server_default="1.0"))


def downgrade() -> None:
    op.drop_column("markers", "scale")
