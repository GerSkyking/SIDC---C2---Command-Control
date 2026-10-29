"""Projekt-Ordner (project_folders, projects.folder_id) + plan_folders.created_by

Revision ID: 0030_project_folders
Revises: 0029_projects
Create Date: 2026-10-29
"""
import sqlalchemy as sa
from alembic import op

revision = "0030_project_folders"
down_revision = "0029_projects"
branch_labels = None
depends_on = None

_ID = sa.String(length=32)


def _cols(insp, table: str) -> set[str]:
    return {c["name"] for c in insp.get_columns(table)}


def _idx(insp, table: str) -> set[str]:
    return {i["name"] for i in insp.get_indexes(table)}


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    have = set(insp.get_table_names())

    if "project_folders" not in have:
        op.create_table(
            "project_folders",
            sa.Column("id", _ID, primary_key=True),
            sa.Column("name", sa.String(length=120), nullable=False),
            sa.Column("parent_id", _ID, sa.ForeignKey("project_folders.id", ondelete="SET NULL"), index=True),
            sa.Column("ordering", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("created_by", _ID, sa.ForeignKey("users.id", ondelete="SET NULL")),
            sa.Column("created_at", sa.DateTime(timezone=True)),
        )

    insp = sa.inspect(bind)
    if "projects" in have and "folder_id" not in _cols(insp, "projects"):
        op.add_column("projects", sa.Column("folder_id", _ID, nullable=True))
        if bind.dialect.name != "sqlite":
            op.create_foreign_key("fk_projects_folder_id", "projects", "project_folders",
                                  ["folder_id"], ["id"], ondelete="SET NULL")
    insp = sa.inspect(bind)
    if "projects" in have and "ix_projects_folder_id" not in _idx(insp, "projects"):
        op.create_index("ix_projects_folder_id", "projects", ["folder_id"])

    if "plan_folders" in have and "created_by" not in _cols(insp, "plan_folders"):
        op.add_column("plan_folders", sa.Column("created_by", _ID, nullable=True))
        if bind.dialect.name != "sqlite":
            op.create_foreign_key("fk_plan_folders_created_by", "plan_folders", "users",
                                  ["created_by"], ["id"], ondelete="SET NULL")


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    have = set(insp.get_table_names())

    if "plan_folders" in have and "created_by" in _cols(insp, "plan_folders"):
        with op.batch_alter_table("plan_folders") as b:
            if bind.dialect.name != "sqlite":
                b.drop_constraint("fk_plan_folders_created_by", type_="foreignkey")
            b.drop_column("created_by")

    insp = sa.inspect(bind)
    if "projects" in have and "folder_id" in _cols(insp, "projects"):
        if "ix_projects_folder_id" in _idx(insp, "projects"):
            op.drop_index("ix_projects_folder_id", table_name="projects")
        with op.batch_alter_table("projects") as b:
            if bind.dialect.name != "sqlite":
                b.drop_constraint("fk_projects_folder_id", type_="foreignkey")
            b.drop_column("folder_id")

    if "project_folders" in have:
        op.drop_table("project_folders")
