"""project_refs: Typ-Spalten auf 16 Zeichen (Quelle "annotation" passte nicht in String(8))

Revision ID: 0042_project_refs_len
Revises: 0041_project_feedback
Create Date: 2026-11-04
"""
import sqlalchemy as sa
from alembic import op

revision = "0042_project_refs_len"
down_revision = "0041_project_feedback"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("project_refs") as batch_op:
        batch_op.alter_column("source_type", existing_type=sa.String(8), type_=sa.String(16), existing_nullable=False)
        batch_op.alter_column("target_type", existing_type=sa.String(8), type_=sa.String(16), existing_nullable=False)


def downgrade() -> None:
    with op.batch_alter_table("project_refs") as batch_op:
        batch_op.alter_column("source_type", existing_type=sa.String(16), type_=sa.String(8), existing_nullable=False)
        batch_op.alter_column("target_type", existing_type=sa.String(16), type_=sa.String(8), existing_nullable=False)
