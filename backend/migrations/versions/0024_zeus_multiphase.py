"""Zeus-Rolle (User/Group), Zeus-Freigabe an Phasen, Marker in mehreren Phasen

Revision ID: 0024_zeus_multiphase
Revises: 0023_favorite_tint
Create Date: 2026-10-23
"""
import sqlalchemy as sa
from alembic import op

revision = "0024_zeus_multiphase"
down_revision = "0023_favorite_tint"
branch_labels = None
depends_on = None


def _add(table: str, col: sa.Column) -> None:
    insp = sa.inspect(op.get_bind())
    if insp.has_table(table) and col.name not in {c["name"] for c in insp.get_columns(table)}:
        with op.batch_alter_table(table) as batch_op:
            batch_op.add_column(col)


def upgrade() -> None:
    _add("users", sa.Column("is_zeus", sa.Boolean(), nullable=False, server_default=sa.false()))
    _add("groups", sa.Column("is_zeus", sa.Boolean(), nullable=False, server_default=sa.false()))
    _add("phases", sa.Column("zeus_released", sa.Boolean(), nullable=False, server_default=sa.false()))
    _add("phases", sa.Column("zeus_until", sa.DateTime(timezone=True), nullable=True))
    _add("markers", sa.Column("extra_phase_ids", sa.JSON(), nullable=True))


def downgrade() -> None:
    for table, col in (
        ("users", "is_zeus"), ("groups", "is_zeus"), ("phases", "zeus_released"),
        ("phases", "zeus_until"), ("markers", "extra_phase_ids"),
    ):
        insp = sa.inspect(op.get_bind())
        if insp.has_table(table) and col in {c["name"] for c in insp.get_columns(table)}:
            with op.batch_alter_table(table) as batch_op:
                batch_op.drop_column(col)
