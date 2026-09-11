"""plan_images: note (längere Markdown-Notiz, zusätzlich zum kurzen Namen)

Revision ID: 0018_plan_image_note
Revises: 0017_plan_images
Create Date: 2026-09-11
"""
import sqlalchemy as sa
from alembic import op

revision = "0018_plan_image_note"
down_revision = "0017_plan_images"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if insp.has_table("plan_images") and "note" not in {c["name"] for c in insp.get_columns("plan_images")}:
        op.add_column(
            "plan_images",
            sa.Column("note", sa.Text(), nullable=False, server_default=""),
        )


def downgrade() -> None:
    op.drop_column("plan_images", "note")
