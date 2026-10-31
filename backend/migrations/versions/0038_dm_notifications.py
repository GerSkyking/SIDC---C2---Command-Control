"""Discord-DM: Outbox-Art, Plan-Bezug der Benachrichtigungen

Revision ID: 0038_dm_notifications
Revises: 0037_bridge_channels
Create Date: 2026-10-31
"""
import sqlalchemy as sa
from alembic import op

revision = "0038_dm_notifications"
down_revision = "0037_bridge_channels"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "kind" not in {c["name"] for c in insp.get_columns("bridge_outbox")}:
        op.add_column("bridge_outbox", sa.Column("kind", sa.String(8), nullable=False, server_default="channel"))
    if "plan_id" not in {c["name"] for c in insp.get_columns("notifications")}:
        op.add_column("notifications", sa.Column("plan_id", sa.String(32)))


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "plan_id" in {c["name"] for c in insp.get_columns("notifications")}:
        op.drop_column("notifications", "plan_id")
    if "kind" in {c["name"] for c in insp.get_columns("bridge_outbox")}:
        op.drop_column("bridge_outbox", "kind")
