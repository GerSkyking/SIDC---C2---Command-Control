"""User: display_name (frei änderbarer Anzeigename)

Revision ID: 0016_user_display_name
Revises: 0015_user_session_epoch
Create Date: 2026-09-10
"""
import sqlalchemy as sa
from alembic import op

revision = "0016_user_display_name"
down_revision = "0015_user_session_epoch"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if insp.has_table("users") and "display_name" not in {c["name"] for c in insp.get_columns("users")}:
        op.add_column(
            "users",
            sa.Column("display_name", sa.String(length=64), nullable=False, server_default=""),
        )


def downgrade() -> None:
    op.drop_column("users", "display_name")
