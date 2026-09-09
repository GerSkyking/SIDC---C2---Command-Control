"""Phase: end_at; Plan: h_hour (Zeitstrahl)

Revision ID: 0011_phase_times
Revises: 0010_stroke_channel_annot_height
Create Date: 2026-09-09
"""
import sqlalchemy as sa
from alembic import op

revision = "0011_phase_times"
down_revision = "0010_stroke_channel_annot_height"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if insp.has_table("phases") and "end_at" not in {c["name"] for c in insp.get_columns("phases")}:
        op.add_column("phases", sa.Column("end_at", sa.DateTime(timezone=True), nullable=True))
    if insp.has_table("plans") and "h_hour" not in {c["name"] for c in insp.get_columns("plans")}:
        op.add_column("plans", sa.Column("h_hour", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("phases", "end_at")
    op.drop_column("plans", "h_hour")
