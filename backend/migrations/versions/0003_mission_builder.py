"""mission-builder Rolle + parallele Phasen-Ebenen

Revision ID: 0003_mission_builder
Revises: 0002_annotations
Create Date: 2026-09-08
"""
import sqlalchemy as sa
from alembic import op

revision = "0003_mission_builder"
down_revision = "0002_annotations"
branch_labels = None
depends_on = None


def _cols(table: str) -> set[str]:
    insp = sa.inspect(op.get_bind())
    return {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    if "is_mission_builder" not in _cols("users"):
        op.add_column("users", sa.Column("is_mission_builder", sa.Boolean(), nullable=False,
                                         server_default=sa.false()))
    if "is_mission_builder" not in _cols("groups"):
        op.add_column("groups", sa.Column("is_mission_builder", sa.Boolean(), nullable=False,
                                          server_default=sa.false()))
    pcols = _cols("phases")
    if "plane" not in pcols:
        op.add_column("phases", sa.Column("plane", sa.String(length=8), nullable=False,
                                          server_default="player"))
    if "parent_id" not in pcols:
        op.add_column("phases", sa.Column("parent_id", sa.String(length=32), nullable=True))
    if "sub_ordering" not in pcols:
        op.add_column("phases", sa.Column("sub_ordering", sa.Integer(), nullable=False,
                                          server_default="0"))


def downgrade() -> None:
    op.drop_column("phases", "sub_ordering")
    op.drop_column("phases", "parent_id")
    op.drop_column("phases", "plane")
    op.drop_column("groups", "is_mission_builder")
    op.drop_column("users", "is_mission_builder")
