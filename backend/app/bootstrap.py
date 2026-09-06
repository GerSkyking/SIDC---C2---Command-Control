"""Beim Start: Tabellen sicherstellen und Bootstrap-Admin idempotent anlegen."""
from __future__ import annotations

import logging

from sqlalchemy import select

from .config import get_settings
from .db import Base, SessionLocal, engine
from .models import User
from .security import MIN_PASSWORD_LEN, hash_password

log = logging.getLogger("sidc.bootstrap")


def init_db() -> None:
    # Phase 1: create_all. Alembic-Baseline folgt in einer eigenen Phase (siehe PLAN.md).
    Base.metadata.create_all(bind=engine)


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
