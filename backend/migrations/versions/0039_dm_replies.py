"""Antworten auf Discord-DMs: Zuordnung DM -> Benachrichtigung

Revision ID: 0039_dm_replies
Revises: 0038_dm_notifications
Create Date: 2026-10-31
"""
import sqlalchemy as sa
from alembic import op

revision = "0039_dm_replies"
down_revision = "0038_dm_notifications"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "notification_id" not in {c["name"] for c in insp.get_columns("bridge_outbox")}:
        op.add_column("bridge_outbox", sa.Column("notification_id", sa.String(32)))
    if "bridge_dm_refs" not in set(insp.get_table_names()):
        op.create_table(
            "bridge_dm_refs",
            sa.Column("id", sa.String(32), primary_key=True),
            sa.Column("provider", sa.String(16), nullable=False),
            sa.Column("message_id", sa.String(32), nullable=False),
            sa.Column("notification_id", sa.String(32), sa.ForeignKey("notifications.id", ondelete="CASCADE"),
                      index=True, nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), index=True),
            sa.UniqueConstraint("provider", "message_id", name="uq_bridge_dm_ref"),
        )


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "bridge_dm_refs" in set(insp.get_table_names()):
        op.drop_table("bridge_dm_refs")
    if "notification_id" in {c["name"] for c in insp.get_columns("bridge_outbox")}:
        op.drop_column("bridge_outbox", "notification_id")
