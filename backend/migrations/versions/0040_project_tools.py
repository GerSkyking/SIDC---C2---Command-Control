"""Missionsbau-Werkzeuge Phase 1: Datei-Typ, Verweis-Index, Zeitleisten-Index

Revision ID: 0040_project_tools
Revises: 0039_dm_replies
Create Date: 2026-11-03
"""
import sqlalchemy as sa
from alembic import op

revision = "0040_project_tools"
down_revision = "0039_dm_replies"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "doc_type" not in {c["name"] for c in insp.get_columns("project_docs")}:
        with op.batch_alter_table("project_docs") as batch_op:
            batch_op.add_column(sa.Column("doc_type", sa.String(16), nullable=False, server_default=""))
    tables = set(insp.get_table_names())
    if "project_refs" not in tables:
        op.create_table(
            "project_refs",
            sa.Column("id", sa.String(32), primary_key=True),
            sa.Column("project_id", sa.String(32), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
            sa.Column("source_type", sa.String(8), nullable=False),
            sa.Column("source_id", sa.String(32), nullable=False),
            sa.Column("target_type", sa.String(8), nullable=False),
            sa.Column("target_id", sa.String(300), nullable=False),
        )
        op.create_index("ix_project_refs_project_id", "project_refs", ["project_id"])
        op.create_index("ix_project_refs_source", "project_refs", ["source_type", "source_id"])
        op.create_index("ix_project_refs_target", "project_refs", ["project_id", "target_type", "target_id"])
    if "project_timeline" not in tables:
        op.create_table(
            "project_timeline",
            sa.Column("id", sa.String(32), primary_key=True),
            sa.Column("project_id", sa.String(32), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
            sa.Column("doc_id", sa.String(32), sa.ForeignKey("project_docs.id", ondelete="CASCADE"), nullable=False),
            sa.Column("space", sa.String(8), nullable=False),
            sa.Column("ord_key", sa.String(24), nullable=False),
            sa.Column("heading", sa.String(200), nullable=False, server_default=""),
            sa.Column("level", sa.Integer, nullable=False, server_default="2"),
            sa.Column("day", sa.Integer, nullable=True),
            sa.Column("minutes", sa.Integer, nullable=False, server_default="0"),
            sa.Column("relative", sa.Boolean, nullable=False, server_default=sa.false()),
            sa.Column("position", sa.Integer, nullable=False, server_default="0"),
        )
        op.create_index("ix_project_timeline_doc_id", "project_timeline", ["doc_id"])
        op.create_index("ix_project_timeline_order", "project_timeline", ["project_id", "ord_key"])


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    tables = set(insp.get_table_names())
    for t in ("project_timeline", "project_refs"):
        if t in tables:
            op.drop_table(t)
    if "doc_type" in {c["name"] for c in insp.get_columns("project_docs")}:
        with op.batch_alter_table("project_docs") as batch_op:
            batch_op.drop_column("doc_type")
