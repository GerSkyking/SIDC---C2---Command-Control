"""Nachholen von 0049_oidc_access für Datenbanken, die schon auf 0053 standen

Revision ID: 0054_oidc_access_catchup
Revises: 0053_marker_area
Create Date: 2026-11-15

``0049_oidc_access`` wurde nachträglich vor ``0049_admin_mission_builder`` in die Kette gehängt.
Eine Datenbank, die bereits auf 0050–0053 stand, überspringt sie deshalb. Diese Migration legt
dieselben Spalten und dieselbe Tabelle an, falls sie fehlen; wo ``0049_oidc_access`` schon lief,
passiert nichts.
"""
import sqlalchemy as sa
from alembic import op

revision = "0054_oidc_access_catchup"
down_revision = "0053_marker_area"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in sa.inspect(bind).get_columns("users")}
    for name in ("deactivated_by_sync", "is_bootstrap"):
        if name not in cols:
            with op.batch_alter_table("users") as b:
                b.add_column(sa.Column(name, sa.Boolean(), nullable=False, server_default=sa.false()))

    if not bind.dialect.has_table(bind, "oidc_link_codes"):
        op.create_table(
            "oidc_link_codes",
            sa.Column("id", sa.String(length=32), primary_key=True),
            sa.Column("user_id", sa.String(length=32), sa.ForeignKey("users.id", ondelete="CASCADE"),
                      nullable=False, index=True),
            sa.Column("code_hash", sa.String(length=64), nullable=False, unique=True, index=True),
            sa.Column("created_by", sa.String(length=32), sa.ForeignKey("users.id", ondelete="SET NULL")),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("used_at", sa.DateTime(timezone=True)),
        )


def downgrade() -> None:
    pass
