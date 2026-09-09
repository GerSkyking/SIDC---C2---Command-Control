"""PublicShare: include_builder

Revision ID: 0013_share_include_builder
Revises: 0012_user_ui_settings
Create Date: 2026-09-09
"""
import sqlalchemy as sa
from alembic import op

revision = "0013_share_include_builder"
down_revision = "0012_user_ui_settings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if insp.has_table("public_shares") and "include_builder" not in {
        c["name"] for c in insp.get_columns("public_shares")
    }:
        op.add_column(
            "public_shares",
            sa.Column("include_builder", sa.Boolean(), nullable=False, server_default=sa.false()),
        )


def downgrade() -> None:
    op.drop_column("public_shares", "include_builder")
