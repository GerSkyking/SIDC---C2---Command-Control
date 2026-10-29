"""Fehlende Indizes: group_members.user_id, orbat_nodes.parent_id, plan_orbats.orbat_id

Revision ID: 0028_missing_indexes
Revises: 0027_annotation_extra_phases
Create Date: 2026-10-29
"""
import sqlalchemy as sa
from alembic import op

revision = "0028_missing_indexes"
down_revision = "0027_annotation_extra_phases"
branch_labels = None
depends_on = None

_INDEXES = [
    ("ix_group_members_user_id", "group_members", "user_id"),
    ("ix_orbat_nodes_parent_id", "orbat_nodes", "parent_id"),
    ("ix_plan_orbats_orbat_id", "plan_orbats", "orbat_id"),
]


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    for name, table, col in _INDEXES:
        if insp.has_table(table) and name not in {i["name"] for i in insp.get_indexes(table)}:
            op.create_index(name, table, [col])


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    for name, table, _ in _INDEXES:
        if insp.has_table(table) and name in {i["name"] for i in insp.get_indexes(table)}:
            op.drop_index(name, table_name=table)
