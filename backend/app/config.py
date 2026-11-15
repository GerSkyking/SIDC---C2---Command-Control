"""Zentrale Konfiguration — alles über Umgebungsvariablen (siehe deploy/.env.example)."""
from __future__ import annotations

import secrets
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

SECRET_KEY_FILE = Path("/data/uploads/secret_key")


# Längste Beschriftung, die als Name des Anmeldedienstes an die Oberfläche geht (AUTH-R-001).
OIDC_PROVIDER_NAME_MAX = 40


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://sidc:change-me@db:5432/sidc"
    redis_url: str = "redis://redis:6379/0"

    secret_key: str = ""
    cookie_secure: Literal["auto", "true", "false"] = "auto"
    forwarded_allow_ips: str = "127.0.0.1"
    session_ttl_days: int = 7
    # Feinere Sitzungsdauer in Stunden; hat Vorrang vor SESSION_TTL_DAYS, wenn > 0 (AUTH-R-008).
    session_ttl_hours: int = 0
    # Lokale Anmeldung: "all" = jedes lokale Konto, "bootstrap-admin" = nur der Start-Admin
    # als Notfallzugang (AUTH-R-002).
    local_login: Literal["all", "bootstrap-admin"] = "all"

    bootstrap_admin_user: str = "admin"
    bootstrap_admin_password: str = ""
    # Neue Nutzer (lokal + OIDC-Erstlogin) automatisch dieser Gruppe zuordnen (Name).
    # Leer = aus. Nützlich für externe Auth: eine "Alle"-Gruppe mit Basis-Zugriff.
    default_user_group: str = ""

    maps_dir: Path = Path("/data/maps")
    uploads_dir: Path = Path("/data/uploads")
    map_import_max_mb: int = 2048
    image_max_mb: int = 10  # Plan-Bilder (in der DB gespeichert)

    # Standardfarben der Straßen-Ebene (Hex). Nutzer können sie im Ebenen-Panel überschreiben.
    road_color_main: str = "#000000"
    road_color_secondary: str = "#4a2e14"
    road_color_path: str = "#8c8c8c"

    # Audit-Log-Aufbewahrung (Tage). 0 = deaktiviert (Log wächst unbegrenzt).
    audit_log_retention_days: int = 180

    # Externe Benachrichtigungen (Discord, ntfy, Matrix, Web-Push, E-Mail …) – siehe services/channels.py
    public_url: str = ""  # z. B. https://c2.example.org – für Links in Benachrichtigungen
    # Selbst gehostete Dienste im LAN (ntfy, Gotify, Matrix) erreichbar machen. Aus = nur öffentliche Adressen.
    notify_allow_private_hosts: bool = False
    # Gemeinsames Geheimnis für externe Brücken (Discord-Bot …). Leer = Brücken-Schnittstelle aus.
    bridge_token: str = ""
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    smtp_starttls: bool = True

    oidc_enabled: bool = False
    oidc_issuer: str = ""
    oidc_client_id: str = ""
    oidc_client_secret: str = ""
    oidc_redirect_url: str = ""
    # Angeforderte Scopes. Die E-Mail wird nur verwendet, wenn "email" hier steht (AUTH-R-006).
    oidc_scopes: str = "openid email profile"
    # Name des Claims mit den Gruppen der Person.
    oidc_groups_claim: str = "groups"
    # Zugangsgruppen (kommagetrennt): mindestens eine muss im Token stehen. Leer = keine Prüfung
    # (AUTH-R-003).
    oidc_required_groups: str = ""
    # Rechtegruppen je Recht (kommagetrennt). Leer = Recht ist nicht angebunden und wird von Hand
    # gepflegt; gesetzt = jeder OIDC-Login setzt das Recht genau nach den Gruppen (AUTH-R-007/-008).
    oidc_admin_groups: str = ""
    oidc_mission_builder_groups: str = ""
    oidc_zeus_groups: str = ""
    oidc_create_plans_groups: str = ""
    oidc_technician_groups: str = ""
    oidc_manage_maps_groups: str = ""
    # Anzeigename bei jedem OIDC-Login aus dem Token übernehmen (AUTH-R-005).
    oidc_sync_display_name: bool = False
    # Name des Anmeldedienstes, wie ihn die Nutzer kennen; steht auf dem Anmeldeknopf und in den
    # Hinweisen der Anmeldeseite. Leer = neutrale Texte wie bisher (AUTH-R-001).
    oidc_provider_name: str = ""

    @field_validator(
        "session_ttl_hours", "local_login", "oidc_scopes", "oidc_groups_claim", "oidc_sync_display_name",
        mode="before",
    )
    @classmethod
    def _empty_means_default(cls, value, info):
        """Eine leer durchgereichte Variable (``LOCAL_LOGIN=``) zählt wie nicht gesetzt."""
        if isinstance(value, str) and not value.strip():
            return cls.model_fields[info.field_name].default
        return value

    @field_validator(
        "oidc_required_groups", "oidc_admin_groups", "oidc_mission_builder_groups", "oidc_zeus_groups",
        "oidc_create_plans_groups", "oidc_technician_groups", "oidc_manage_maps_groups",
    )
    @classmethod
    def _group_list_names_a_group(cls, value: str, info):
        """Eine gesetzte Liste ohne Gruppe (``","``, ``" "``) wäre still „keine Prüfung“ bzw. „nicht
        angebunden“. Das ist fast sicher ein Tippfehler, deshalb startet das Backend damit nicht."""
        if value != "" and not any(part.strip() for part in value.split(",")):
            raise ValueError(
                f"{info.field_name.upper()} ist gesetzt, nennt aber keine Gruppe. "
                "Gruppennamen kommagetrennt eintragen oder die Variable leer lassen."
            )
        return value

    def session_ttl_seconds(self) -> int:
        """Gültigkeit der Sitzung: SESSION_TTL_HOURS, wenn gesetzt, sonst SESSION_TTL_DAYS."""
        if self.session_ttl_hours > 0:
            return self.session_ttl_hours * 3600
        return self.session_ttl_days * 86400

    def oidc_provider_label(self) -> str:
        """Name des Anmeldedienstes für die Oberfläche: ohne Steuerzeichen, Leerraum
        zusammengefasst, höchstens ``OIDC_PROVIDER_NAME_MAX`` Zeichen. Leer = nicht gesetzt."""
        printable = "".join(ch if ch.isprintable() else " " for ch in self.oidc_provider_name)
        return " ".join(printable.split())[:OIDC_PROVIDER_NAME_MAX].rstrip()

    def oidc_scope_set(self) -> set[str]:
        return set(self.oidc_scopes.split())

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
