"""User: ui_settings (Keybinds/Theme pro Nutzer)

Revision ID: 0012_user_ui_settings
Revises: 0011_phase_times
Create Date: 2026-09-09
"""
import sqlalchemy as sa
from alembic import op

revision = "0012_user_ui_settings"
down_revision = "0011_phase_times"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if insp.has_table("users") and "ui_settings" not in {c["name"] for c in insp.get_columns("users")}:
        op.add_column(
            "users",
            sa.Column("ui_settings", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        )


def downgrade() -> None:
    op.drop_column("users", "ui_settings")
