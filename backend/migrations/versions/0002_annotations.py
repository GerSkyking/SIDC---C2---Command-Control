"""annotations – platzierbare Markdown-Textfelder

Revision ID: 0002_annotations
Revises: 0001_baseline
Create Date: 2026-09-08
"""
import sqlalchemy as sa
from alembic import op

revision = "0002_annotations"
down_revision = "0001_baseline"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if op.get_bind().dialect.has_table(op.get_bind(), "annotations"):
        return
    op.create_table(
        "annotations",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("plan_id", sa.String(length=32), sa.ForeignKey("plans.id", ondelete="CASCADE"), index=True),
        sa.Column("phase_id", sa.String(length=32), sa.ForeignKey("phases.id", ondelete="SET NULL"), index=True),
        sa.Column("world_x", sa.Float(), nullable=False),
        sa.Column("world_y", sa.Float(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False, server_default=""),
        sa.Column("width", sa.Float(), nullable=False, server_default="220"),
        sa.Column("created_by", sa.String(length=32), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("updated_by", sa.String(length=32), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("created_at", sa.DateTime(timezone=True)),
        sa.Column("updated_at", sa.DateTime(timezone=True)),
    )


def downgrade() -> None:
    op.drop_table("annotations")
