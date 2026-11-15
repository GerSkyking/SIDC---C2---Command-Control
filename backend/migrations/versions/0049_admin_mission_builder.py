"""Adminrolle schließt Missionsbau nicht mehr ein: bestehenden Admins das Flag explizit setzen

Revision ID: 0049_admin_mission_builder
Revises: 0048_stroke_ai_text
Create Date: 2026-11-15
"""
import sqlalchemy as sa
from alembic import op

revision = "0049_admin_mission_builder"
down_revision = "0048_stroke_ai_text"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Verhalten für bestehende Admins bleibt gleich; neue Admins bekommen es nicht mehr automatisch.
    op.execute(sa.text("UPDATE users SET is_mission_builder = :t WHERE role = 'admin'").bindparams(t=True))


def downgrade() -> None:
    pass
