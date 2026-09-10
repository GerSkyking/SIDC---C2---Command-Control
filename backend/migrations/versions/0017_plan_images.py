"""plan_images – Bilder zu einem Plan (BLOB), optional auf der Karte platziert

Revision ID: 0017_plan_images
Revises: 0016_user_display_name
Create Date: 2026-09-10
"""
import sqlalchemy as sa
from alembic import op

revision = "0017_plan_images"
down_revision = "0016_user_display_name"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if op.get_bind().dialect.has_table(op.get_bind(), "plan_images"):
        return
    op.create_table(
        "plan_images",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("plan_id", sa.String(length=32), sa.ForeignKey("plans.id", ondelete="CASCADE"), index=True),
        sa.Column("phase_id", sa.String(length=32), sa.ForeignKey("phases.id", ondelete="SET NULL"), index=True),
        sa.Column("filename", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("content_type", sa.String(length=32), nullable=False, server_default="image/png"),
        sa.Column("byte_size", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("natural_w", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("natural_h", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("caption", sa.Text(), nullable=False, server_default=""),
        sa.Column("data", sa.LargeBinary(), nullable=False),
        sa.Column("on_map", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("world_x", sa.Float(), nullable=False, server_default="0"),
        sa.Column("world_y", sa.Float(), nullable=False, server_default="0"),
        sa.Column("map_width", sa.Float(), nullable=False, server_default="240"),
        sa.Column("scale_fixed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("ref_zoom", sa.Float(), nullable=False, server_default="0"),
        sa.Column("created_by", sa.String(length=32), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("updated_by", sa.String(length=32), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("created_at", sa.DateTime(timezone=True)),
        sa.Column("updated_at", sa.DateTime(timezone=True)),
    )


def downgrade() -> None:
    op.drop_table("plan_images")
