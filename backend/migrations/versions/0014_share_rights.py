"""PublicShare: Rechte + Phasen/Zeit-Eingrenzung je Link

Revision ID: 0014_share_rights
Revises: 0013_share_include_builder
Create Date: 2026-09-09
"""
import sqlalchemy as sa
from alembic import op

revision = "0014_share_rights"
down_revision = "0013_share_include_builder"
branch_labels = None
depends_on = None


def _cols(insp, table):
    return {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if not insp.has_table("public_shares"):
        return
    have = _cols(insp, "public_shares")
    if "can_point" not in have:
        op.add_column("public_shares", sa.Column("can_point", sa.Boolean(), nullable=False, server_default=sa.true()))
    if "can_edit" not in have:
        op.add_column("public_shares", sa.Column("can_edit", sa.Boolean(), nullable=False, server_default=sa.false()))
    if "can_move" not in have:
        op.add_column("public_shares", sa.Column("can_move", sa.Boolean(), nullable=False, server_default=sa.false()))
    if "phase_ids" not in have:
        op.add_column("public_shares", sa.Column("phase_ids", sa.JSON(), nullable=False, server_default=sa.text("'[]'")))
    if "date_from" not in have:
        op.add_column("public_shares", sa.Column("date_from", sa.DateTime(timezone=True), nullable=True))
    if "date_to" not in have:
        op.add_column("public_shares", sa.Column("date_to", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    for c in ("can_point", "can_edit", "can_move", "phase_ids", "date_from", "date_to"):
        op.drop_column("public_shares", c)
