"""Brücke: Momentaufnahme der vom Bot gesehenen Kanäle (Auswahl im Admin-Bereich)

Revision ID: 0037_bridge_channels
Revises: 0036_bridge
Create Date: 2026-10-31
"""
import sqlalchemy as sa
from alembic import op

revision = "0037_bridge_channels"
down_revision = "0036_bridge"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if "bridge_channels" not in set(sa.inspect(op.get_bind()).get_table_names()):
        op.create_table(
            "bridge_channels",
            sa.Column("id", sa.String(length=32), primary_key=True),
            sa.Column("provider", sa.String(16), nullable=False),
            sa.Column("external_id", sa.String(64), nullable=False),
            sa.Column("name", sa.String(120), nullable=False, server_default=""),
            sa.Column("group_id", sa.String(64), nullable=False, server_default=""),
            sa.Column("group_name", sa.String(120), nullable=False, server_default=""),
            sa.Column("updated_at", sa.DateTime(timezone=True)),
            sa.UniqueConstraint("provider", "external_id", name="uq_bridge_channel_ext"),
        )


def downgrade() -> None:
    if "bridge_channels" in set(sa.inspect(op.get_bind()).get_table_names()):
        op.drop_table("bridge_channels")
