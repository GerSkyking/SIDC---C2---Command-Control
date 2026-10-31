"""Chat (Unterhaltungen, Mitglieder, Nachrichten) + Benachrichtigungen

Revision ID: 0034_chat
Revises: 0033_task_comments
Create Date: 2026-10-31
"""
import sqlalchemy as sa
from alembic import op

revision = "0034_chat"
down_revision = "0033_task_comments"
branch_labels = None
depends_on = None

_ID = sa.String(length=32)


def upgrade() -> None:
    have = set(sa.inspect(op.get_bind()).get_table_names())
    if "conversations" not in have:
        op.create_table(
            "conversations",
            sa.Column("id", _ID, primary_key=True),
            sa.Column("kind", sa.String(8), nullable=False),
            sa.Column("name", sa.String(80), nullable=False, server_default=""),
            sa.Column("dm_key", sa.String(70), unique=True),
            sa.Column("source_type", sa.String(8)),
            sa.Column("source_id", _ID),
            sa.Column("created_by", _ID, sa.ForeignKey("users.id", ondelete="SET NULL")),
            sa.Column("created_at", sa.DateTime(timezone=True)),
            sa.Column("updated_at", sa.DateTime(timezone=True), index=True),
        )
    if "conversation_members" not in have:
        op.create_table(
            "conversation_members",
            sa.Column("conversation_id", _ID, sa.ForeignKey("conversations.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("user_id", _ID, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True),
            sa.Column("last_read_at", sa.DateTime(timezone=True)),
        )
    if "messages" not in have:
        op.create_table(
            "messages",
            sa.Column("id", _ID, primary_key=True),
            sa.Column("conversation_id", _ID, sa.ForeignKey("conversations.id", ondelete="CASCADE"), index=True, nullable=False),
            sa.Column("user_id", _ID, sa.ForeignKey("users.id", ondelete="SET NULL")),
            sa.Column("text", sa.Text(), nullable=False),
            sa.Column("mentions", sa.JSON(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), index=True),
            sa.Column("edited_at", sa.DateTime(timezone=True)),
        )
    if "notifications" not in have:
        op.create_table(
            "notifications",
            sa.Column("id", _ID, primary_key=True),
            sa.Column("user_id", _ID, sa.ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False),
            sa.Column("kind", sa.String(16), nullable=False),
            sa.Column("actor_id", _ID, sa.ForeignKey("users.id", ondelete="SET NULL")),
            sa.Column("title", sa.String(200), nullable=False, server_default=""),
            sa.Column("text", sa.String(300), nullable=False, server_default=""),
            sa.Column("project_id", _ID, sa.ForeignKey("projects.id", ondelete="CASCADE")),
            sa.Column("task_id", _ID, sa.ForeignKey("project_tasks.id", ondelete="CASCADE")),
            sa.Column("conversation_id", _ID, sa.ForeignKey("conversations.id", ondelete="CASCADE")),
            sa.Column("read_at", sa.DateTime(timezone=True)),
            sa.Column("created_at", sa.DateTime(timezone=True), index=True),
        )


def downgrade() -> None:
    have = set(sa.inspect(op.get_bind()).get_table_names())
    for t in ("notifications", "messages", "conversation_members", "conversations"):
        if t in have:
            op.drop_table(t)
