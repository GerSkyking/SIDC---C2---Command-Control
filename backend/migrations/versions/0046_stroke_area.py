"""Benannte Flächen beim Zeichnen: strokes.closed / name / sidc / fill

Eine geschlossene Linie (``closed``) wird als Fläche gezeichnet (``fill`` = schraffiert gefüllt),
optional mit Namen und SIDC-Symbol (taktische Grafik) am Schwerpunkt.

Revision ID: 0046_stroke_area
Revises: 0045_annotation_area
Create Date: 2026-11-12
"""
import sqlalchemy as sa
from alembic import op

revision = "0046_stroke_area"
down_revision = "0045_annotation_area"
branch_labels = None
depends_on = None

_COLS = (
    ("closed", lambda: sa.Column("closed", sa.Boolean(), nullable=False, server_default=sa.false())),
    ("name", lambda: sa.Column("name", sa.String(128), nullable=False, server_default="")),
    ("sidc", lambda: sa.Column("sidc", sa.String(32), nullable=False, server_default="")),
    ("fill", lambda: sa.Column("fill", sa.Boolean(), nullable=False, server_default=sa.true())),
)


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    cols = {c["name"] for c in insp.get_columns("strokes")}
    missing = [mk for name, mk in _COLS if name not in cols]
    if missing:
        with op.batch_alter_table("strokes") as batch_op:
            for mk in missing:
                batch_op.add_column(mk())


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    cols = {c["name"] for c in insp.get_columns("strokes")}
    present = [name for name, _ in _COLS if name in cols]
    if present:
        with op.batch_alter_table("strokes") as batch_op:
            for name in present:
                batch_op.drop_column(name)
