"""Favoriten: channel-Spalte

Revision ID: 0008_favorite_channel
Revises: 0007_annotation_scale
Create Date: 2026-09-09
"""
import sqlalchemy as sa
from alembic import op

revision = "0008_favorite_channel"
down_revision = "0007_annotation_scale"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if insp.has_table("favorites") and "channel" not in {c["name"] for c in insp.get_columns("favorites")}:
        op.add_column("favorites", sa.Column("channel", sa.String(length=64), nullable=False, server_default=""))


def downgrade() -> None:
    op.drop_column("favorites", "channel")
