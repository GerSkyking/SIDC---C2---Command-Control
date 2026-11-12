"""Flächen/Linien mit SIDC-Symbol: Zusatztext (strokes.ai_text)

Revision ID: 0048_stroke_ai_text
Revises: 0047_annotation_color
Create Date: 2026-11-12
"""
import sqlalchemy as sa
from alembic import op

revision = "0048_stroke_ai_text"
down_revision = "0047_annotation_color"
branch_labels = None
depends_on = None


def upgrade() -> None:
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("strokes")}
    if "ai_text" not in cols:
        with op.batch_alter_table("strokes") as b:
            b.add_column(sa.Column("ai_text", sa.String(128), nullable=False, server_default=""))


def downgrade() -> None:
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("strokes")}
    if "ai_text" in cols:
        with op.batch_alter_table("strokes") as b:
            b.drop_column("ai_text")
