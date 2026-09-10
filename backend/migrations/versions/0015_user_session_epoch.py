"""User: session_epoch (Session-Invalidierung bei Passwortwechsel)

Revision ID: 0015_user_session_epoch
Revises: 0014_share_rights
Create Date: 2026-09-10
"""
import sqlalchemy as sa
from alembic import op

revision = "0015_user_session_epoch"
down_revision = "0014_share_rights"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if insp.has_table("users") and "session_epoch" not in {c["name"] for c in insp.get_columns("users")}:
        op.add_column(
            "users",
            sa.Column("session_epoch", sa.Integer(), nullable=False, server_default="0"),
        )


def downgrade() -> None:
    op.drop_column("users", "session_epoch")
