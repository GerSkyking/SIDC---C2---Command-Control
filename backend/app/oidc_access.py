"""Zugang und Rechte aus den Gruppen im OIDC-Token (Spec „Anmeldung und Zugriff“).

Alles hier hängt an Einstellungen (ADR 0003): Ohne ``OIDC_REQUIRED_GROUPS`` gibt es keine
Zugangsprüfung, ohne ``OIDC_*_GROUPS`` ist kein Recht angebunden, und das Tool verhält sich
wie vor dieser Spec. Im Code stehen keine Namen von Gruppen.
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .config import Settings, get_settings
from .models import OidcIdentity, OidcLinkCode, User, now

# Feld am Nutzer -> Einstellung mit den Rechtegruppen (AUTH-R-007).
_RIGHT_SETTINGS = {
    "role": "oidc_admin_groups",
    "is_mission_builder": "oidc_mission_builder_groups",
    "is_zeus": "oidc_zeus_groups",
    "can_create_plans": "oidc_create_plans_groups",
    "is_technician": "oidc_technician_groups",
    "can_manage_maps": "oidc_manage_maps_groups",
}

# Gültigkeit eines Verknüpfungscodes (AUTH-R-014). Lang genug, um den Link weiterzugeben,
# kurz genug, dass ein liegen gebliebener Link verfällt.
LINK_CODE_TTL = timedelta(hours=24)

_NAME_FORBIDDEN = frozenset("<>\"'`&")  # wie beim selbst gesetzten Anzeigenamen (HTML-Kontexte)


def _csv(value: str) -> set[str]:
    return {part.strip() for part in (value or "").split(",") if part.strip()}


def required_groups(s: Settings | None = None) -> set[str]:
    return _csv((s or get_settings()).oidc_required_groups)


def right_groups(s: Settings | None = None) -> dict[str, set[str]]:
    """Angebundene Rechte: Feld am Nutzer -> Rechtegruppen. Nicht angebundene fehlen."""
    s = s or get_settings()
    out = {field: _csv(getattr(s, name)) for field, name in _RIGHT_SETTINGS.items()}
    return {field: groups for field, groups in out.items() if groups}


def managed_fields(s: Settings | None = None) -> list[str]:
    """Felder, die der Abgleich bei OIDC-Konten setzt und die Verwaltung deshalb sperrt."""
    return list(right_groups(s))


def token_groups(claims: dict, s: Settings | None = None) -> set[str]:
    """Gruppen der Person aus dem Token. Fehlt der Claim oder hat er eine unerwartete Form,
    gilt die Person als in keiner Gruppe."""
    raw = claims.get((s or get_settings()).oidc_groups_claim)
    if isinstance(raw, str):
        return {raw} if raw else set()
    if isinstance(raw, (list, tuple, set)):
        return {g for g in raw if isinstance(g, str) and g}
    return set()


def has_access(groups: set[str], s: Settings | None = None) -> bool:
    """AUTH-R-003: Ohne eingestellte Zugangsgruppe darf jeder, sonst nur mit mindestens einer."""
    required = required_groups(s)
    return not required or bool(required & groups)


def is_bootstrap_admin(user: User) -> bool:
    """Start-Admin ist nur das Konto mit dem festen Merkmal, das ``ensure_bootstrap_admin``
    beim Start setzt. Der Benutzername zählt nicht: Den kann ein OIDC-Konto zufällig tragen."""
    return bool(user.is_bootstrap)


def sync_rights(user: User, groups: set[str], s: Settings | None = None) -> dict[str, list]:
    """AUTH-R-008: angebundene Rechte genau nach den Gruppen setzen. Gibt die Änderungen als
    ``{feld: [alt, neu]}`` zurück (leer, wenn nichts zu ändern war). Der Start-Admin bleibt
    immer Admin (AUTH-R-010). Schreibt nicht selbst in die Datenbank."""
    s = s or get_settings()
    changes: dict[str, list] = {}
    for field, wanted_groups in right_groups(s).items():
        granted = bool(wanted_groups & groups)
        if field == "role":
            new: object = "admin" if granted or is_bootstrap_admin(user) else "user"
        else:
            new = granted
        old = getattr(user, field)
        if old != new:
            setattr(user, field, new)
            changes[field] = [old, new]
    return changes


def display_name_from(claims: dict) -> str:
    """AUTH-R-005: ``name``, sonst ``preferred_username``; bereinigt wie ein selbst gesetzter Name."""
    raw = claims.get("name") or claims.get("preferred_username") or ""
    if not isinstance(raw, str):
        return ""
    return "".join(c for c in raw.strip() if c.isprintable() and c not in _NAME_FORBIDDEN)[:64]


def username_base(claims: dict, subject: str, s: Settings | None = None) -> str:
    """AUTH-R-006: Login-Name aus ``preferred_username``; die E-Mail dient nur als Rückfall,
    wenn sie über ``OIDC_SCOPES`` auch angefordert wird; sonst ``oidc-<Anfang des sub>``."""
    s = s or get_settings()
    name = claims.get("preferred_username")
    if not name and "email" in s.oidc_scope_set():
        name = claims.get("email")
    return name if isinstance(name, str) and name else f"oidc-{subject[:8]}"


def user_ids_with_identity(db: Session) -> set[str]:
    return set(db.scalars(select(OidcIdentity.user_id)))


def has_identity(db: Session, user_id: str) -> bool:
    return db.scalar(select(OidcIdentity.id).where(OidcIdentity.user_id == user_id)) is not None


# ─── Verknüpfen bestehender Konten (AUTH-R-014) ────────────────────────────

def _hash(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def create_link_code(db: Session, user: User, created_by: str | None) -> tuple[str, datetime]:
    """Neuen Einmal-Code für das Konto anlegen; ältere Codes des Kontos verfallen damit."""
    for old in db.scalars(select(OidcLinkCode).where(OidcLinkCode.user_id == user.id)):
        db.delete(old)
    code = secrets.token_urlsafe(32)
    expires = now() + LINK_CODE_TTL
    db.add(OidcLinkCode(user_id=user.id, code_hash=_hash(code), created_by=created_by, expires_at=expires))
    db.commit()
    return code, expires


def find_link_code(db: Session, code: str) -> OidcLinkCode | None:
    """Gültigen (unbenutzten, nicht abgelaufenen) Code finden."""
    if not code:
        return None
    row = db.scalar(select(OidcLinkCode).where(OidcLinkCode.code_hash == _hash(code)))
    if row is None or row.used_at is not None or _aware(row.expires_at) <= now():
        return None
    return row


def consume_link_code(db: Session, row: OidcLinkCode) -> bool:
    """Code atomar verbrauchen: Nur eine Anfrage bekommt ``True``, auch wenn zwei denselben
    Code gleichzeitig einlösen. Schreibt in der laufenden Transaktion (kein Commit)."""
    result = db.execute(
        update(OidcLinkCode)
        .where(OidcLinkCode.id == row.id, OidcLinkCode.used_at.is_(None))
        .values(used_at=now())
        .execution_options(synchronize_session=False)
    )
    return result.rowcount == 1
