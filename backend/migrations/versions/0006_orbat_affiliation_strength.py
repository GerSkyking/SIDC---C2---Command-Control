"""ORBAT: Zugehörigkeit auf 4 Standard-Identitäten, markers.orbat_strength

Revision ID: 0006_orbat_aff_strength
Revises: 0005_marker_orbat
Create Date: 2026-09-08
"""
import sqlalchemy as sa
from alembic import op

revision = "0006_orbat_aff_strength"
down_revision = "0005_marker_orbat"
branch_labels = None
depends_on = None


def _has_col(table: str, col: str) -> bool:
    insp = sa.inspect(op.get_bind())
    return insp.has_table(table) and col in {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_col("markers", "orbat_strength"):
        op.add_column(
            "markers",
            sa.Column("orbat_strength", sa.Integer(), nullable=False, server_default="1"),
        )
    if sa.inspect(bind).has_table("orbats"):
        op.execute("UPDATE orbats SET affiliation = 'friend' WHERE affiliation = 'own'")
        op.execute("UPDATE orbats SET affiliation = 'hostile' WHERE affiliation = 'enemy'")


def downgrade() -> None:
    op.execute("UPDATE orbats SET affiliation = 'own' WHERE affiliation = 'friend'")
    op.execute("UPDATE orbats SET affiliation = 'enemy' WHERE affiliation = 'hostile'")
    op.drop_column("markers", "orbat_strength")
