"""Marker: tint-Spalte (eigene Farbe je Marker)

Revision ID: 0022_marker_tint
Revises: 0021_api_tokens
Create Date: 2026-10-14
"""
import sqlalchemy as sa
from alembic import op

revision = "0022_marker_tint"
down_revision = "0021_api_tokens"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if insp.has_table("markers") and "tint" not in {c["name"] for c in insp.get_columns("markers")}:
        op.add_column("markers", sa.Column("tint", sa.String(9), nullable=False, server_default=""))


def downgrade() -> None:
    op.drop_column("markers", "tint")
