"""Zentrale Konfiguration — alles über Umgebungsvariablen (siehe deploy/.env.example)."""
from __future__ import annotations

import secrets
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

SECRET_KEY_FILE = Path("/data/uploads/secret_key")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://sidc:change-me@db:5432/sidc"
    redis_url: str = "redis://redis:6379/0"

    secret_key: str = ""
    cookie_secure: Literal["auto", "true", "false"] = "auto"
    forwarded_allow_ips: str = "127.0.0.1"
    session_ttl_days: int = 7

    bootstrap_admin_user: str = "admin"
    bootstrap_admin_password: str = ""
    # Neue Nutzer (lokal + OIDC-Erstlogin) automatisch dieser Gruppe zuordnen (Name).
    # Leer = aus. Nützlich für externe Auth: eine "Alle"-Gruppe mit Basis-Zugriff.
    default_user_group: str = ""

    maps_dir: Path = Path("/data/maps")
    uploads_dir: Path = Path("/data/uploads")
    map_import_max_mb: int = 2048

    oidc_enabled: bool = False
    oidc_issuer: str = ""
    oidc_client_id: str = ""
    oidc_client_secret: str = ""
    oidc_redirect_url: str = ""

    def resolved_secret_key(self) -> str:
        """SECRET_KEY aus der Env, sonst ein persistenter, beim ersten Start generierter Wert."""
        if self.secret_key:
            return self.secret_key
        if SECRET_KEY_FILE.exists():
            return SECRET_KEY_FILE.read_text().strip()
        SECRET_KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
        key = secrets.token_urlsafe(48)
        SECRET_KEY_FILE.write_text(key)
        SECRET_KEY_FILE.chmod(0o600)
        return key


@lru_cache
def get_settings() -> Settings:
    return Settings()
