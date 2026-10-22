"""Phasen: player_released (Missionsbau-Phase für Spieler freigeben)

Revision ID: 0025_player_released
Revises: 0024_zeus_multiphase
Create Date: 2026-10-23
"""
import sqlalchemy as sa
from alembic import op

revision = "0025_player_released"
down_revision = "0024_zeus_multiphase"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if insp.has_table("phases") and "player_released" not in {c["name"] for c in insp.get_columns("phases")}:
        with op.batch_alter_table("phases") as b:
            b.add_column(sa.Column("player_released", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    with op.batch_alter_table("phases") as b:
        b.drop_column("player_released")
