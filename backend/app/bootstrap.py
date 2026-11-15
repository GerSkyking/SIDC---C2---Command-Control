"""Beim Start: Tabellen sicherstellen und Bootstrap-Admin idempotent anlegen."""
from __future__ import annotations

import logging
from pathlib import Path

from sqlalchemy import inspect, select, text

from .config import get_settings
from .db import Base, SessionLocal, engine
from .models import OidcIdentity, User
from .security import MIN_PASSWORD_LEN, hash_password

log = logging.getLogger("sidc.bootstrap")

_BACKEND_DIR = Path(__file__).resolve().parent.parent


def _alembic_cfg():
    from alembic.config import Config

    cfg = Config(str(_BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(_BACKEND_DIR / "migrations"))
    cfg.set_main_option("sqlalchemy.url", get_settings().database_url)
    return cfg


def init_db() -> None:
    """Alembic ist die Wahrheit fürs Schema. Bestehende (per create_all gebaute)
    Datenbanken werden einmalig auf die Baseline gestampt (keine DDL); danach läuft
    ``upgrade head``. ``_add_missing_columns()`` bleibt als Sicherheitsnetz während
    der Umstellung."""
    try:
        from alembic import command

        tables = set(inspect(engine).get_table_names())
        cfg = _alembic_cfg()
        if "alembic_version" not in tables and "users" in tables:
            command.stamp(cfg, "0001_baseline")
            log.info("Alembic: Bestandsschema auf Baseline gestampt")
        command.upgrade(cfg, "head")
    except Exception as exc:  # noqa: BLE001 — Fallback auf create_all, nie den Start blockieren
        # Kein log.exception: der Traceback kann die DATABASE_URL inkl. Passwort enthalten.
        log.error("Alembic-Migration fehlgeschlagen (%s) — Fallback create_all", type(exc).__name__)
    # Sicherheitsnetz während der Umstellung: fehlende Tabellen/Spalten ergänzen
    # (create_all fasst bestehende Tabellen nicht an).
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


_PLACEHOLDER_PASSWORDS = {"change-me-min-12-chars", "change-me", "changeme", "password1234", "admin1234567"}


PUBLIC_GROUP = "public"


def ensure_public_group() -> None:
    """Systemgruppe "public": jeder Nutzer gehört implizit dazu (Plan-Freigabe an alle)."""
    from .models import Group

    with SessionLocal() as db:
        g = db.scalar(select(Group).where(Group.name == PUBLIC_GROUP))
        if g is None:
            db.add(Group(name=PUBLIC_GROUP, is_system=True))
            db.commit()
        elif not g.is_system:
            g.is_system = True
            db.commit()


def _mark_bootstrap_admin() -> bool:
    """Das feste Merkmal ``is_bootstrap`` pflegen (AUTH-R-010): Es gehört genau dem lokalen
    Konto mit dem Namen aus ``BOOTSTRAP_ADMIN_USER``. Ein Konto, das über OIDC entstanden oder
    verbunden ist, bekommt es nie, auch wenn es so heißt. Gibt zurück, ob das Konto dieses
    Namens der Start-Admin ist (oder noch keines existiert)."""
    s = get_settings()
    with SessionLocal() as db:
        for other in db.scalars(select(User).where(User.is_bootstrap.is_(True), User.username != s.bootstrap_admin_user)):
            other.is_bootstrap = False  # BOOTSTRAP_ADMIN_USER wurde geändert
        user = db.scalar(select(User).where(User.username == s.bootstrap_admin_user))
        ok = True
        if user is not None and not user.is_bootstrap:
            has_identity = db.scalar(select(OidcIdentity.id).where(OidcIdentity.user_id == user.id)) is not None
            if has_identity or not user.password_hash:
                log.error(
                    "Konto '%s' heißt wie BOOTSTRAP_ADMIN_USER, ist aber kein lokales Konto — "
                    "es wird nicht als Start-Admin behandelt", s.bootstrap_admin_user,
                )
                ok = False
            else:
                user.is_bootstrap = True
        db.commit()
        return ok


def ensure_bootstrap_admin() -> None:
    s = get_settings()
    is_ours = _mark_bootstrap_admin()
    if not s.bootstrap_admin_password:
        log.warning("BOOTSTRAP_ADMIN_PASSWORD leer — kein lokaler Admin angelegt")
        return
    if len(s.bootstrap_admin_password) < MIN_PASSWORD_LEN:
        log.error("BOOTSTRAP_ADMIN_PASSWORD zu kurz (min. %d Zeichen)", MIN_PASSWORD_LEN)
        return

    if s.bootstrap_admin_password.strip().lower() in _PLACEHOLDER_PASSWORDS:
        log.error("BOOTSTRAP_ADMIN_PASSWORD ist ein bekannter Platzhalter — bitte aendern")
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
                    is_mission_builder=True,  # das lokale Konto ist gesperrt (Rechte nur per Konfiguration) → Rechte hier festlegen
                    is_bootstrap=True,
                )
            )
            db.commit()
            log.info("Bootstrap-Admin '%s' angelegt", s.bootstrap_admin_user)
        elif is_ours and user.role != "admin":
            user.role = "admin"
            db.commit()
            log.info("Bootstrap-User '%s' auf Adminrolle gehoben", s.bootstrap_admin_user)
