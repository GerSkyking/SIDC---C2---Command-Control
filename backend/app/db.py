"""SQLAlchemy-Engine, Session-Factory, Base."""
from __future__ import annotations

import uuid
from collections.abc import Iterator

from sqlalchemy import String, create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import get_settings

_settings = get_settings()

# SQLite (Tests) braucht check_same_thread=False; Postgres ignoriert connect_args.
_connect_args = {"check_same_thread": False} if _settings.database_url.startswith("sqlite") else {}
engine = create_engine(_settings.database_url, pool_pre_ping=True, connect_args=_connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def uuid_str() -> str:
    return uuid.uuid4().hex


# Kurzalias für UUID-Primärschlüssel-Spalten
UuidPk = String(32)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
