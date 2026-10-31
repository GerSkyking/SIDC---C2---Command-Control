"""Externe Benachrichtigungskanäle (Discord, ntfy, Matrix, Web-Push …)

Revision ID: 0035_notification_channels
Revises: 0034_chat
Create Date: 2026-10-31
"""
import sqlalchemy as sa
from alembic import op

revision = "0035_notification_channels"
down_revision = "0034_chat"
branch_labels = None
depends_on = None

_ID = sa.String(length=32)


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    have = set(insp.get_table_names())
    if "notification_channels" not in have:
        op.create_table(
            "notification_channels",
            sa.Column("id", _ID, primary_key=True),
            sa.Column("user_id", _ID, sa.ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False),
            sa.Column("type", sa.String(16), nullable=False),
            sa.Column("name", sa.String(80), nullable=False, server_default=""),
            sa.Column("config", sa.JSON(), nullable=False),
            sa.Column("kinds", sa.JSON(), nullable=False),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("last_ok_at", sa.DateTime(timezone=True)),
            sa.Column("last_error", sa.String(300), nullable=False, server_default=""),
            sa.Column("created_at", sa.DateTime(timezone=True)),
        )
    if "notifications" in have and "dispatched_at" not in {c["name"] for c in insp.get_columns("notifications")}:
        op.add_column("notifications", sa.Column("dispatched_at", sa.DateTime(timezone=True)))
        op.create_index("ix_notifications_dispatched_at", "notifications", ["dispatched_at"])
        # Altbestand gilt als zugestellt – sonst würden beim ersten Start alte Einträge gepusht.
        op.execute("UPDATE notifications SET dispatched_at = created_at")


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "notification_channels" in insp.get_table_names():
        op.drop_table("notification_channels")
    if "dispatched_at" in {c["name"] for c in insp.get_columns("notifications")}:
        op.drop_index("ix_notifications_dispatched_at", table_name="notifications")
        op.drop_column("notifications", "dispatched_at")
