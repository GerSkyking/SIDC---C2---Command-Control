"""Aufgaben-Threads (task_comments)

Revision ID: 0033_task_comments
Revises: 0032_project_activity
Create Date: 2026-10-31
"""
import sqlalchemy as sa
from alembic import op

revision = "0033_task_comments"
down_revision = "0032_project_activity"
branch_labels = None
depends_on = None

_ID = sa.String(length=32)


def upgrade() -> None:
    if "task_comments" in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        "task_comments",
        sa.Column("id", _ID, primary_key=True),
        sa.Column("project_id", _ID, sa.ForeignKey("projects.id", ondelete="CASCADE"), index=True, nullable=False),
        sa.Column("task_id", _ID, sa.ForeignKey("project_tasks.id", ondelete="CASCADE"), index=True, nullable=False),
        sa.Column("user_id", _ID, sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("mentions", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), index=True),
        sa.Column("edited_at", sa.DateTime(timezone=True)),
    )


def downgrade() -> None:
    if "task_comments" in sa.inspect(op.get_bind()).get_table_names():
        op.drop_table("task_comments")
