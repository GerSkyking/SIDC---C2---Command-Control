"""plans.deleted_by – wer hat den Plan in den Papierkorb gelegt (Sichtbarkeit im Papierkorb)

Revision ID: 0051_plan_deleted_by
Revises: 0050_rights_model
Create Date: 2026-11-15
"""
import sqlalchemy as sa
from alembic import op

revision = "0051_plan_deleted_by"
down_revision = "0050_rights_model"
branch_labels = None
depends_on = None


def upgrade() -> None:
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("plans")}
    if "deleted_by" not in cols:
        with op.batch_alter_table("plans") as b:
            b.add_column(sa.Column("deleted_by", sa.String(length=32), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("plans") as b:
        b.drop_column("deleted_by")
