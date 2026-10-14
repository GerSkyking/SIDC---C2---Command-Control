"""Favoriten: tint-Spalte (eigene Markerfarbe)

Revision ID: 0023_favorite_tint
Revises: 0022_marker_tint
Create Date: 2026-10-14
"""
import sqlalchemy as sa
from alembic import op

revision = "0023_favorite_tint"
down_revision = "0022_marker_tint"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if insp.has_table("favorites") and "tint" not in {c["name"] for c in insp.get_columns("favorites")}:
        op.add_column("favorites", sa.Column("tint", sa.String(9), nullable=False, server_default=""))


def downgrade() -> None:
    op.drop_column("favorites", "tint")
