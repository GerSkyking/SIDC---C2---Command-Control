"""Rechtemodell: Techniker, Karten verwalten, Systemgruppe "public", Projekt-Missionsbau

Revision ID: 0050_rights_model
Revises: 0049_admin_mission_builder
Create Date: 2026-11-15
"""
import uuid

import sqlalchemy as sa
from alembic import op

revision = "0050_rights_model"
down_revision = "0049_admin_mission_builder"
branch_labels = None
depends_on = None

PUBLIC_GROUP = "public"


def _add(table: str, col: str) -> None:
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}
    if col not in cols:
        with op.batch_alter_table(table) as b:
            b.add_column(sa.Column(col, sa.Boolean(), nullable=False, server_default=sa.false()))


def upgrade() -> None:
    for table in ("users", "groups"):
        _add(table, "is_technician")
        _add(table, "can_manage_maps")
    _add("groups", "is_system")
    _add("project_members", "is_builder")
    bind = op.get_bind()
    exists = bind.execute(sa.text("SELECT id FROM groups WHERE name = :n"), {"n": PUBLIC_GROUP}).first()
    if exists is None:
        bind.execute(
            sa.text("INSERT INTO groups (id, name, can_create_plans, is_mission_builder, is_zeus, is_technician, "
                    "can_manage_maps, is_system, created_at) VALUES (:i, :n, :f, :f, :f, :f, :f, :t, CURRENT_TIMESTAMP)"),
            {"i": uuid.uuid4().hex, "n": PUBLIC_GROUP, "f": False, "t": True},
        )
    else:
        bind.execute(sa.text("UPDATE groups SET is_system = :t WHERE name = :n"), {"t": True, "n": PUBLIC_GROUP})


def downgrade() -> None:
    pass
