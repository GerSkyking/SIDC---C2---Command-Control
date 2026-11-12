"""Bereich an Stern-Pins/Notizen: annotations.area (JSON {"pts": [[lng, lat], ...], "closed": bool})

Revision ID: 0045_annotation_area
Revises: 0044_annotation_zeus
Create Date: 2026-11-12
"""
import sqlalchemy as sa
from alembic import op

revision = "0045_annotation_area"
down_revision = "0044_annotation_zeus"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    cols = {c["name"] for c in insp.get_columns("annotations")}
    if "area" not in cols:
        with op.batch_alter_table("annotations") as batch_op:
            batch_op.add_column(sa.Column("area", sa.JSON(), nullable=True))


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    cols = {c["name"] for c in insp.get_columns("annotations")}
    if "area" in cols:
        with op.batch_alter_table("annotations") as batch_op:
            batch_op.drop_column("area")
