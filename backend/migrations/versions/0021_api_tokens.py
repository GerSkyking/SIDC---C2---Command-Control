"""api_tokens – persönliche API-Tokens (Scope maps:read) für den lokalen Client

Revision ID: 0021_api_tokens
Revises: 0020_phase_locked
Create Date: 2026-09-20
"""
import sqlalchemy as sa
from alembic import op

revision = "0021_api_tokens"
down_revision = "0020_phase_locked"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if op.get_bind().dialect.has_table(op.get_bind(), "api_tokens"):
        return
    op.create_table(
        "api_tokens",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("user_id", sa.String(length=32), sa.ForeignKey("users.id", ondelete="CASCADE"), index=True),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False, unique=True, index=True),
        sa.Column("prefix", sa.String(length=16), nullable=False),
        sa.Column("scopes", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True)),
        sa.Column("last_used_at", sa.DateTime(timezone=True)),
        sa.Column("expires_at", sa.DateTime(timezone=True)),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
    )


def downgrade() -> None:
    op.drop_table("api_tokens")
