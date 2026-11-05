"""Einzelfreigabe von Karten-Notizen fuer Zeus: annotations.zeus_released / zeus_until

Revision ID: 0044_annotation_zeus
Revises: 0043_notes_layer
Create Date: 2026-11-05
"""
import sqlalchemy as sa
from alembic import op

revision = "0044_annotation_zeus"
down_revision = "0043_notes_layer"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    cols = {c["name"] for c in insp.get_columns("annotations")}
    with op.batch_alter_table("annotations") as batch_op:
        if "zeus_released" not in cols:
            batch_op.add_column(sa.Column("zeus_released", sa.Boolean(), nullable=False, server_default=sa.false()))
        if "zeus_until" not in cols:
            batch_op.add_column(sa.Column("zeus_until", sa.DateTime(timezone=True), nullable=True))
    # Die Ebene selbst wird nicht mehr freigegeben (nur einzelne Pins): eine zuvor gesetzte
    # Ebenen-Freigabe zuruecknehmen, damit nichts unbemerkt fuer Zeus sichtbar bleibt.
    op.execute("UPDATE phases SET zeus_released = false, zeus_until = NULL WHERE role = 'notes'")


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    cols = {c["name"] for c in insp.get_columns("annotations")}
    with op.batch_alter_table("annotations") as batch_op:
        if "zeus_until" in cols:
            batch_op.drop_column("zeus_until")
        if "zeus_released" in cols:
            batch_op.drop_column("zeus_released")
