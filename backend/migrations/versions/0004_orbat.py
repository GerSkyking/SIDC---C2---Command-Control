"""ORBAT: orbats / orbat_nodes / orbat_acl / plan_orbats

Revision ID: 0004_orbat
Revises: 0003_mission_builder
Create Date: 2026-09-08
"""
import sqlalchemy as sa
from alembic import op

revision = "0004_orbat"
down_revision = "0003_mission_builder"
branch_labels = None
depends_on = None


def _has(table: str) -> bool:
    return sa.inspect(op.get_bind()).has_table(table)


def upgrade() -> None:
    if not _has("orbats"):
        op.create_table(
            "orbats",
            sa.Column("id", sa.String(length=32), primary_key=True),
            sa.Column("name", sa.String(length=128), nullable=False),
            sa.Column("affiliation", sa.String(length=12), nullable=False, server_default="own"),
            sa.Column("notes", sa.Text(), nullable=False, server_default=""),
            sa.Column("created_by", sa.String(length=32), sa.ForeignKey("users.id", ondelete="SET NULL")),
            sa.Column("created_at", sa.DateTime(timezone=True)),
        )
    if not _has("orbat_nodes"):
        op.create_table(
            "orbat_nodes",
            sa.Column("id", sa.String(length=32), primary_key=True),
            sa.Column("orbat_id", sa.String(length=32), sa.ForeignKey("orbats.id", ondelete="CASCADE"), index=True),
            sa.Column("parent_id", sa.String(length=32), sa.ForeignKey("orbat_nodes.id", ondelete="CASCADE")),
            sa.Column("name", sa.String(length=128), nullable=False),
            sa.Column("sidc", sa.String(length=64), nullable=False, server_default=""),
            sa.Column("qty_planned", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("qty_current", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("status", sa.String(length=12), nullable=False, server_default="active"),
            sa.Column("ordering", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("notes", sa.Text(), nullable=False, server_default=""),
            sa.Column("rel_visible", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("rel_show_type", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("rel_strength", sa.Integer(), nullable=False, server_default="50"),
        )
    if not _has("orbat_acl"):
        op.create_table(
            "orbat_acl",
            sa.Column("id", sa.String(length=32), primary_key=True),
            sa.Column("orbat_id", sa.String(length=32), sa.ForeignKey("orbats.id", ondelete="CASCADE"), index=True),
            sa.Column("subject_type", sa.String(length=8), nullable=False),
            sa.Column("subject_id", sa.String(length=32), nullable=False),
            sa.Column("level", sa.String(length=8), nullable=False),
            sa.Column("can_place", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("can_move", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.UniqueConstraint("orbat_id", "subject_type", "subject_id", name="uq_orbat_acl_subject"),
        )
    if not _has("plan_orbats"):
        op.create_table(
            "plan_orbats",
            sa.Column("plan_id", sa.String(length=32), sa.ForeignKey("plans.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("orbat_id", sa.String(length=32), sa.ForeignKey("orbats.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("added_by", sa.String(length=32), sa.ForeignKey("users.id", ondelete="SET NULL")),
            sa.Column("added_at", sa.DateTime(timezone=True)),
        )


def downgrade() -> None:
    op.drop_table("plan_orbats")
    op.drop_table("orbat_acl")
    op.drop_table("orbat_nodes")
    op.drop_table("orbats")
