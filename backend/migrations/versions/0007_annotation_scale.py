"""Annotationen: scale_fixed + ref_zoom (Zoom-Skalierung)

Revision ID: 0007_annotation_scale
Revises: 0006_orbat_aff_strength
Create Date: 2026-09-08
"""
import sqlalchemy as sa
from alembic import op

revision = "0007_annotation_scale"
down_revision = "0006_orbat_aff_strength"
branch_labels = None
depends_on = None


def _cols(table: str) -> set[str]:
    insp = sa.inspect(op.get_bind())
    return {c["name"] for c in insp.get_columns(table)} if insp.has_table(table) else set()


def upgrade() -> None:
    have = _cols("annotations")
    if "annotations" not in {t for t in sa.inspect(op.get_bind()).get_table_names()}:
        return
    if "scale_fixed" not in have:
        op.add_column("annotations", sa.Column("scale_fixed", sa.Boolean(), nullable=False, server_default=sa.false()))
    if "ref_zoom" not in have:
        op.add_column("annotations", sa.Column("ref_zoom", sa.Float(), nullable=False, server_default="0"))


def downgrade() -> None:
    op.drop_column("annotations", "ref_zoom")
    op.drop_column("annotations", "scale_fixed")
