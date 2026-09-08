"""baseline – gesamtes Schema aus den Modellen

Revision ID: 0001_baseline
Revises:
Create Date: 2026-09-08

Bestehende Datenbanken (per create_all aufgebaut) werden mit
``alembic stamp 0001_baseline`` auf diese Revision gehoben (keine DDL).
Neue Datenbanken bekommen das komplette Schema aus den Modellen.
"""
from alembic import op

from app.db import Base
import app.models  # noqa: F401

revision = "0001_baseline"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    Base.metadata.create_all(bind=op.get_bind())


def downgrade() -> None:
    Base.metadata.drop_all(bind=op.get_bind())
