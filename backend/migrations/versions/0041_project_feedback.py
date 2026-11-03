"""Missionsbau-Werkzeuge Phase 2: Feedback, Meilensteine, Status, Dok-Kommentare, Dok-Versionen

Revision ID: 0041_project_feedback
Revises: 0040_project_tools
Create Date: 2026-11-03
"""
import sqlalchemy as sa
from alembic import op

revision = "0041_project_feedback"
down_revision = "0040_project_tools"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    cols = {c["name"] for c in insp.get_columns("projects")}
    with op.batch_alter_table("projects") as batch_op:
        if "stage" not in cols:
            batch_op.add_column(sa.Column("stage", sa.String(8), nullable=False, server_default="draft"))
        if "feedback_token" not in cols:
            batch_op.add_column(sa.Column("feedback_token", sa.String(40), nullable=True))
    if "ix_projects_feedback_token" not in {i["name"] for i in sa.inspect(op.get_bind()).get_indexes("projects")}:
        op.create_index("ix_projects_feedback_token", "projects", ["feedback_token"], unique=True)

    tables = set(insp.get_table_names())
    if "project_feedback" not in tables:
        op.create_table(
            "project_feedback",
            sa.Column("id", sa.String(32), primary_key=True),
            sa.Column("project_id", sa.String(32), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
            sa.Column("title", sa.String(200), nullable=False),
            sa.Column("text", sa.Text, nullable=False, server_default=""),
            sa.Column("kind", sa.String(8), nullable=False, server_default="other"),
            sa.Column("status", sa.String(8), nullable=False, server_default="new"),
            sa.Column("source", sa.String(8), nullable=False, server_default="internal"),
            sa.Column("author_name", sa.String(80), nullable=False, server_default=""),
            sa.Column("author_user_id", sa.String(32), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("plan_id", sa.String(32), sa.ForeignKey("plans.id", ondelete="SET NULL"), nullable=True),
            sa.Column("doc_id", sa.String(32), sa.ForeignKey("project_docs.id", ondelete="SET NULL"), nullable=True),
            sa.Column("task_id", sa.String(32), sa.ForeignKey("project_tasks.id", ondelete="SET NULL"), nullable=True),
            sa.Column("note", sa.Text, nullable=False, server_default=""),
            sa.Column("handled_by", sa.String(32), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_project_feedback_project_id", "project_feedback", ["project_id"])
        op.create_index("ix_project_feedback_created_at", "project_feedback", ["created_at"])
        op.create_index("ix_project_feedback_status", "project_feedback", ["project_id", "status"])
    if "project_milestones" not in tables:
        op.create_table(
            "project_milestones",
            sa.Column("id", sa.String(32), primary_key=True),
            sa.Column("project_id", sa.String(32), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
            sa.Column("title", sa.String(120), nullable=False),
            sa.Column("due_date", sa.Date, nullable=True),
            sa.Column("done", sa.Boolean, nullable=False, server_default=sa.false()),
            sa.Column("ordering", sa.Integer, nullable=False, server_default="0"),
        )
        op.create_index("ix_project_milestones_project_id", "project_milestones", ["project_id"])
    if "doc_comments" not in tables:
        op.create_table(
            "doc_comments",
            sa.Column("id", sa.String(32), primary_key=True),
            sa.Column("project_id", sa.String(32), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
            sa.Column("doc_id", sa.String(32), sa.ForeignKey("project_docs.id", ondelete="CASCADE"), nullable=False),
            sa.Column("user_id", sa.String(32), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("text", sa.Text, nullable=False),
            sa.Column("mentions", sa.JSON, nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        )
        op.create_index("ix_doc_comments_project_id", "doc_comments", ["project_id"])
        op.create_index("ix_doc_comments_doc_id", "doc_comments", ["doc_id"])
        op.create_index("ix_doc_comments_created_at", "doc_comments", ["created_at"])
    if "project_doc_versions" not in tables:
        op.create_table(
            "project_doc_versions",
            sa.Column("id", sa.String(32), primary_key=True),
            sa.Column("doc_id", sa.String(32), sa.ForeignKey("project_docs.id", ondelete="CASCADE"), nullable=False),
            sa.Column("project_id", sa.String(32), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
            sa.Column("name", sa.String(200), nullable=False),
            sa.Column("content", sa.Text, nullable=False, server_default=""),
            sa.Column("saved_by", sa.String(32), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_project_doc_versions_doc_id", "project_doc_versions", ["doc_id"])
        op.create_index("ix_project_doc_versions_project_id", "project_doc_versions", ["project_id"])
        op.create_index("ix_project_doc_versions_created_at", "project_doc_versions", ["created_at"])


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    tables = set(insp.get_table_names())
    for t in ("project_doc_versions", "doc_comments", "project_milestones", "project_feedback"):
        if t in tables:
            op.drop_table(t)
    if "ix_projects_feedback_token" in {i["name"] for i in insp.get_indexes("projects")}:
        op.drop_index("ix_projects_feedback_token", table_name="projects")
    cols = {c["name"] for c in insp.get_columns("projects")}
    with op.batch_alter_table("projects") as batch_op:
        for c in ("feedback_token", "stage"):
            if c in cols:
                batch_op.drop_column(c)
