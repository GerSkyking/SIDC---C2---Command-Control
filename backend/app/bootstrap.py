"""Beim Start: Tabellen sicherstellen und Bootstrap-Admin idempotent anlegen."""
from __future__ import annotations

import logging

from sqlalchemy import inspect, select, text

from .config import get_settings
from .db import Base, SessionLocal, engine
from .models import User
from .security import MIN_PASSWORD_LEN, hash_password

log = logging.getLogger("sidc.bootstrap")


def init_db() -> None:
    # Phase 1: create_all + einfacher Spalten-Abgleich. Echte Alembic-Baseline folgt
    # (siehe PLAN.md) — bis dahin fängt _add_missing_columns() Modell-Erweiterungen ab.
    Base.metadata.create_all(bind=engine)
    _add_missing_columns()


def _add_missing_columns() -> None:
    """ALTER TABLE ... ADD COLUMN für Spalten, die im Modell dazugekommen sind.
    Nur einfache Spalten mit skalarem Default (kein Rename/Typwechsel — dafür Alembic)."""
    insp = inspect(engine)
    existing_tables = set(insp.get_table_names())
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if table.name not in existing_tables:
                continue
            have = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name in have:
                    continue
                coltype = col.type.compile(engine.dialect)
                default = getattr(col.default, "arg", None)
                clause = f'ALTER TABLE {table.name} ADD COLUMN "{col.name}" {coltype}'
                if default is not None and not callable(default):
                    lit = "TRUE" if default is True else "FALSE" if default is False else repr(default)
                    clause += f" DEFAULT {lit}"
                elif not col.nullable:
                    continue  # NOT NULL ohne Default -> nicht automatisch machbar
                log.warning("Schema-Sync: %s.%s wird ergänzt", table.name, col.name)
                conn.execute(text(clause))


def ensure_bootstrap_admin() -> None:
    s = get_settings()
    if not s.bootstrap_admin_password:
        log.warning("BOOTSTRAP_ADMIN_PASSWORD leer — kein lokaler Admin angelegt")
        return
    if len(s.bootstrap_admin_password) < MIN_PASSWORD_LEN:
        log.error("BOOTSTRAP_ADMIN_PASSWORD zu kurz (min. %d Zeichen)", MIN_PASSWORD_LEN)
        return

    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.username == s.bootstrap_admin_user))
        if user is None:
            db.add(
                User(
                    username=s.bootstrap_admin_user,
                    password_hash=hash_password(s.bootstrap_admin_password),
                    role="admin",
                    can_create_plans=True,
                )
            )
            db.commit()
            log.info("Bootstrap-Admin '%s' angelegt", s.bootstrap_admin_user)
        elif user.role != "admin":
            user.role = "admin"
            db.commit()
            log.info("Bootstrap-User '%s' auf Adminrolle gehoben", s.bootstrap_admin_user)
