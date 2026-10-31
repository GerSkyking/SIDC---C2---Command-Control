"""Whiteboard: Pfeile zwischen Notizen (project_note_links) + Notiz-Verknüpfung mit Aufgabe/Nutzer

Revision ID: 0031_note_links
Revises: 0030_project_folders
Create Date: 2026-10-31
"""
import sqlalchemy as sa
from alembic import op

revision = "0031_note_links"
down_revision = "0030_project_folders"
branch_labels = None
depends_on = None

_ID = sa.String(length=32)


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    have = set(insp.get_table_names())
    if "project_notes" in have:
        cols = {c["name"] for c in insp.get_columns("project_notes")}
        if "task_id" not in cols:
            op.add_column("project_notes", sa.Column("task_id", _ID, nullable=True))
            if bind.dialect.name != "sqlite":
                op.create_foreign_key("fk_project_notes_task_id", "project_notes", "project_tasks",
                                      ["task_id"], ["id"], ondelete="SET NULL")
        if "user_id" not in cols:
            op.add_column("project_notes", sa.Column("user_id", _ID, nullable=True))
            if bind.dialect.name != "sqlite":
                op.create_foreign_key("fk_project_notes_user_id", "project_notes", "users",
                                      ["user_id"], ["id"], ondelete="SET NULL")
    if "project_note_links" not in have:
        op.create_table(
            "project_note_links",
            sa.Column("id", _ID, primary_key=True),
            sa.Column("project_id", _ID, sa.ForeignKey("projects.id", ondelete="CASCADE"), index=True, nullable=False),
            sa.Column("from_id", _ID, sa.ForeignKey("project_notes.id", ondelete="CASCADE"), index=True, nullable=False),
            sa.Column("to_id", _ID, sa.ForeignKey("project_notes.id", ondelete="CASCADE"), index=True, nullable=False),
            sa.Column("created_by", _ID, sa.ForeignKey("users.id", ondelete="SET NULL")),
            sa.Column("created_at", sa.DateTime(timezone=True)),
            sa.UniqueConstraint("from_id", "to_id", name="uq_note_link"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    have = set(insp.get_table_names())
    if "project_note_links" in have:
        op.drop_table("project_note_links")
    if "project_notes" in have:
        cols = {c["name"] for c in insp.get_columns("project_notes")}
        with op.batch_alter_table("project_notes") as b:
            for name in ("task_id", "user_id"):
                if name in cols:
                    if bind.dialect.name != "sqlite":
                        b.drop_constraint(f"fk_project_notes_{name}", type_="foreignkey")
                    b.drop_column(name)
