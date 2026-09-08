"""Marker ↔ ORBAT-Knoten: markers.orbat_node_id

Revision ID: 0005_marker_orbat
Revises: 0004_orbat
Create Date: 2026-09-08
"""
import sqlalchemy as sa
from alembic import op

revision = "0005_marker_orbat"
down_revision = "0004_orbat"
branch_labels = None
depends_on = None


def _has_col(table: str, col: str) -> bool:
    insp = sa.inspect(op.get_bind())
    return insp.has_table(table) and col in {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    if not _has_col("markers", "orbat_node_id"):
        op.add_column(
            "markers",
            sa.Column(
                "orbat_node_id",
                sa.String(length=32),
                sa.ForeignKey("orbat_nodes.id", ondelete="SET NULL"),
                nullable=True,
            ),
        )
        op.create_index("ix_markers_orbat_node_id", "markers", ["orbat_node_id"])


def downgrade() -> None:
    op.drop_index("ix_markers_orbat_node_id", table_name="markers")
    op.drop_column("markers", "orbat_node_id")
