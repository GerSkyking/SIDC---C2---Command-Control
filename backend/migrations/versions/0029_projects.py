"""Missionsbau-Projekte: projects, Mitglieder, Dokumente, Notizen, Aufgaben + project_id an Plänen/Ordnern/Bildern

Revision ID: 0029_projects
Revises: 0028_missing_indexes
Create Date: 2026-10-29
"""
import sqlalchemy as sa
from alembic import op

revision = "0029_projects"
down_revision = "0028_missing_indexes"
branch_labels = None
depends_on = None

_ID = sa.String(length=32)


def _fk(col: str, target: str, ondelete: str | None = None, **kw) -> sa.Column:
    return sa.Column(col, _ID, sa.ForeignKey(target, ondelete=ondelete), **kw)


def _tables(insp) -> set[str]:
    return set(insp.get_table_names())


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    have = _tables(insp)

    if "projects" not in have:
        op.create_table(
            "projects",
            sa.Column("id", _ID, primary_key=True),
            sa.Column("name", sa.String(length=120), nullable=False),
            sa.Column("description", sa.Text(), nullable=False, server_default=""),
            sa.Column("archived", sa.Boolean(), nullable=False, server_default=sa.false()),
            _fk("created_by", "users.id", "SET NULL"),
            sa.Column("created_at", sa.DateTime(timezone=True)),
            sa.Column("updated_at", sa.DateTime(timezone=True)),
        )
    if "project_members" not in have:
        op.create_table(
            "project_members",
            sa.Column("project_id", _ID, sa.ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("subject_type", sa.String(length=8), primary_key=True),
            sa.Column("subject_id", _ID, primary_key=True),
            sa.Column("role", sa.String(length=8), nullable=False),
        )
    if "project_docs" not in have:
        op.create_table(
            "project_docs",
            sa.Column("id", _ID, primary_key=True),
            sa.Column("project_id", _ID, sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True),
            sa.Column("space", sa.String(length=8), nullable=False),
            sa.Column("parent_id", _ID, sa.ForeignKey("project_docs.id", ondelete="CASCADE"), index=True),
            sa.Column("kind", sa.String(length=8), nullable=False),
            sa.Column("name", sa.String(length=200), nullable=False),
            sa.Column("content", sa.Text(), nullable=False, server_default=""),
            sa.Column("ordering", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("byte_size", sa.Integer(), nullable=False, server_default="0"),
            _fk("created_by", "users.id", "SET NULL"),
            _fk("updated_by", "users.id", "SET NULL"),
            sa.Column("created_at", sa.DateTime(timezone=True)),
            sa.Column("updated_at", sa.DateTime(timezone=True)),
        )
    if "project_notes" not in have:
        op.create_table(
            "project_notes",
            sa.Column("id", _ID, primary_key=True),
            sa.Column("project_id", _ID, sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True),
            sa.Column("text", sa.Text(), nullable=False, server_default=""),
            sa.Column("color", sa.String(length=8), nullable=False, server_default="yellow"),
            sa.Column("x", sa.Float(), nullable=False, server_default="0"),
            sa.Column("y", sa.Float(), nullable=False, server_default="0"),
            sa.Column("w", sa.Float(), nullable=False, server_default="220"),
            sa.Column("h", sa.Float(), nullable=False, server_default="160"),
            _fk("created_by", "users.id", "SET NULL"),
            _fk("updated_by", "users.id", "SET NULL"),
            sa.Column("created_at", sa.DateTime(timezone=True)),
            sa.Column("updated_at", sa.DateTime(timezone=True)),
        )
    if "project_tasks" not in have:
        op.create_table(
            "project_tasks",
            sa.Column("id", _ID, primary_key=True),
            sa.Column("project_id", _ID, sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True),
            sa.Column("title", sa.String(length=200), nullable=False),
            sa.Column("description", sa.Text(), nullable=False, server_default=""),
            sa.Column("status", sa.String(length=8), nullable=False, server_default="open"),
            sa.Column("priority", sa.String(length=8), nullable=False, server_default="normal"),
            sa.Column("assignee_id", _ID, sa.ForeignKey("users.id", ondelete="SET NULL"), index=True),
            sa.Column("due_date", sa.Date()),
            sa.Column("ordering", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("plan_id", _ID, sa.ForeignKey("plans.id", ondelete="SET NULL")),
            sa.Column("doc_id", _ID, sa.ForeignKey("project_docs.id", ondelete="SET NULL")),
            _fk("created_by", "users.id", "SET NULL"),
            _fk("updated_by", "users.id", "SET NULL"),
            sa.Column("created_at", sa.DateTime(timezone=True)),
            sa.Column("updated_at", sa.DateTime(timezone=True)),
            sa.Column("done_at", sa.DateTime(timezone=True)),
        )

    # project_id an plans / plan_folders / plan_images (idempotent)
    insp = sa.inspect(bind)
    for table, ondelete in (("plans", "SET NULL"), ("plan_folders", "CASCADE"), ("plan_images", "SET NULL")):
        if table not in _tables(insp):
            continue
        cols = {c["name"] for c in insp.get_columns(table)}
        if "project_id" not in cols:
            op.add_column(table, sa.Column("project_id", _ID, nullable=True))
            if bind.dialect.name != "sqlite":
                op.create_foreign_key(f"fk_{table}_project_id", table, "projects", ["project_id"], ["id"], ondelete=ondelete)
        idx = f"ix_{table}_project_id"
        if idx not in {i["name"] for i in insp.get_indexes(table)}:
            op.create_index(idx, table, ["project_id"])

    # Backfill: Bilder erben project_id vom Plan
    if "plan_images" in _tables(insp) and "plans" in _tables(insp):
        op.execute(
            "UPDATE plan_images SET project_id = "
            "(SELECT plans.project_id FROM plans WHERE plans.id = plan_images.plan_id) "
            "WHERE project_id IS NULL"
        )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    for table in ("plan_images", "plan_folders", "plans"):
        if table not in _tables(insp):
            continue
        if "project_id" in {c["name"] for c in insp.get_columns(table)}:
            idx = f"ix_{table}_project_id"
            if idx in {i["name"] for i in insp.get_indexes(table)}:
                op.drop_index(idx, table_name=table)
            with op.batch_alter_table(table) as b:
                if bind.dialect.name != "sqlite":
                    b.drop_constraint(f"fk_{table}_project_id", type_="foreignkey")
                b.drop_column("project_id")
    for t in ("project_tasks", "project_notes", "project_docs", "project_members", "projects"):
        if t in _tables(sa.inspect(bind)):
            op.drop_table(t)
