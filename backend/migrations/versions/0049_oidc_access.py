"""Anmeldung und Zugriff: users.deactivated_by_sync, users.is_bootstrap, Tabelle oidc_link_codes

Revision ID: 0049_oidc_access
Revises: 0048_stroke_ai_text
Create Date: 2026-11-13

- ``users.deactivated_by_sync`` (AUTH-R-009): unterscheidet „vom Abgleich beim Login
  deaktiviert“ von „vom Admin deaktiviert“. Bestehende Konten bekommen ``false``.
- ``users.is_bootstrap`` (AUTH-R-010): festes Merkmal des Start-Admins. Die Migration setzt
  es nirgends; das Backend markiert beim Start das lokale Konto aus ``BOOTSTRAP_ADMIN_USER``
  (``app/bootstrap.py``), nie ein Konto mit OIDC-Identität.
- ``oidc_link_codes`` (AUTH-R-014): einmalige Codes zum Verknüpfen eines bestehenden Kontos
  mit einer OIDC-Identität.

Beides nur ergänzend; bestehende Daten werden nicht verändert.
"""
import sqlalchemy as sa
from alembic import op

revision = "0049_oidc_access"
down_revision = "0048_stroke_ai_text"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in sa.inspect(bind).get_columns("users")}
    for name in ("deactivated_by_sync", "is_bootstrap"):
        if name not in cols:
            with op.batch_alter_table("users") as b:
                b.add_column(sa.Column(name, sa.Boolean(), nullable=False, server_default=sa.false()))

    if not bind.dialect.has_table(bind, "oidc_link_codes"):
        op.create_table(
            "oidc_link_codes",
            sa.Column("id", sa.String(length=32), primary_key=True),
            sa.Column("user_id", sa.String(length=32), sa.ForeignKey("users.id", ondelete="CASCADE"),
                      nullable=False, index=True),
            sa.Column("code_hash", sa.String(length=64), nullable=False, unique=True, index=True),
            sa.Column("created_by", sa.String(length=32), sa.ForeignKey("users.id", ondelete="SET NULL")),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("used_at", sa.DateTime(timezone=True)),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.has_table(bind, "oidc_link_codes"):
        op.drop_table("oidc_link_codes")
    cols = {c["name"] for c in sa.inspect(bind).get_columns("users")}
    for name in ("is_bootstrap", "deactivated_by_sync"):
        if name in cols:
            with op.batch_alter_table("users") as b:
                b.drop_column(name)
