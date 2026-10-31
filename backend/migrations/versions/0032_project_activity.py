"""Projekt-Aktivitätsfeed (project_activity)

Revision ID: 0032_project_activity
Revises: 0031_note_links
Create Date: 2026-10-31
"""
import sqlalchemy as sa
from alembic import op

revision = "0032_project_activity"
down_revision = "0031_note_links"
branch_labels = None
depends_on = None

_ID = sa.String(length=32)


def upgrade() -> None:
    if "project_activity" in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        "project_activity",
        sa.Column("id", _ID, primary_key=True),
        sa.Column("project_id", _ID, sa.ForeignKey("projects.id", ondelete="CASCADE"), index=True, nullable=False),
        sa.Column("user_id", _ID, sa.ForeignKey("users.id", ondelete="SET NULL"), index=True),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("target_type", sa.String(16), nullable=False),
        sa.Column("target_id", _ID, index=True),
        sa.Column("target_title", sa.String(200), nullable=False, server_default=""),
        sa.Column("space", sa.String(8)),
        sa.Column("detail", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), index=True),
    )


def downgrade() -> None:
    if "project_activity" in sa.inspect(op.get_bind()).get_table_names():
        op.drop_table("project_activity")
