"""Brücke zu Discord/Matrix: Verbindungen, Identitäten, Codes, Outbox; Nachrichten-Herkunft

Revision ID: 0036_bridge
Revises: 0035_notification_channels
Create Date: 2026-10-31
"""
import sqlalchemy as sa
from alembic import op

revision = "0036_bridge"
down_revision = "0035_notification_channels"
branch_labels = None
depends_on = None

_ID = sa.String(length=32)


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    have = set(insp.get_table_names())
    cols = {c["name"] for c in insp.get_columns("messages")}
    if "origin" not in cols:
        op.add_column("messages", sa.Column("origin", sa.String(16)))
    if "ext_author" not in cols:
        op.add_column("messages", sa.Column("ext_author", sa.String(100), nullable=False, server_default=""))
    if "bridge_links" not in have:
        op.create_table(
            "bridge_links",
            sa.Column("id", _ID, primary_key=True),
            sa.Column("conversation_id", _ID, sa.ForeignKey("conversations.id", ondelete="CASCADE"), index=True, nullable=False),
            sa.Column("provider", sa.String(16), nullable=False),
            sa.Column("external_id", sa.String(64), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True)),
            sa.UniqueConstraint("provider", "external_id", name="uq_bridge_link_ext"),
        )
    if "bridge_identities" not in have:
        op.create_table(
            "bridge_identities",
            sa.Column("id", _ID, primary_key=True),
            sa.Column("user_id", _ID, sa.ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False),
            sa.Column("provider", sa.String(16), nullable=False),
            sa.Column("external_id", sa.String(64), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True)),
            sa.UniqueConstraint("provider", "external_id", name="uq_bridge_ident_ext"),
            sa.UniqueConstraint("provider", "user_id", name="uq_bridge_ident_user"),
        )
    if "bridge_codes" not in have:
        op.create_table(
            "bridge_codes",
            sa.Column("code", sa.String(12), primary_key=True),
            sa.Column("kind", sa.String(8), nullable=False),
            sa.Column("user_id", _ID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("conversation_id", _ID, sa.ForeignKey("conversations.id", ondelete="CASCADE")),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        )
    if "bridge_outbox" not in have:
        op.create_table(
            "bridge_outbox",
            sa.Column("id", _ID, primary_key=True),
            sa.Column("provider", sa.String(16), index=True, nullable=False),
            sa.Column("external_id", sa.String(64), nullable=False),
            sa.Column("author", sa.String(100), nullable=False, server_default=""),
            sa.Column("text", sa.Text(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), index=True),
            sa.Column("delivered_at", sa.DateTime(timezone=True), index=True),
        )


def downgrade() -> None:
    have = set(sa.inspect(op.get_bind()).get_table_names())
    for t in ("bridge_outbox", "bridge_codes", "bridge_identities", "bridge_links"):
        if t in have:
            op.drop_table(t)
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("messages")}
    for c in ("ext_author", "origin"):
        if c in cols:
            op.drop_column("messages", c)
