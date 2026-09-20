"""API-Tokens: erzeugen, hashen, per ``Authorization: Bearer`` auflösen."""
from __future__ import annotations

import hashlib
import secrets
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import ApiToken, User, now

TOKEN_PREFIX = "sidc_"
SCOPE_MAPS_READ = "maps:read"
ALL_SCOPES = (SCOPE_MAPS_READ,)
MAX_TOKENS_PER_USER = 20
_LAST_USED_GRANULARITY = timedelta(minutes=1)  # nicht bei jeder Kachel schreiben


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def new_raw_token() -> str:
    return TOKEN_PREFIX + secrets.token_urlsafe(32)


def resolve_token(db: Session, raw: str) -> tuple[ApiToken, User] | None:
    """Gültigen (nicht widerrufen/abgelaufen) Token samt aktivem User zurückgeben."""
    if not raw.startswith(TOKEN_PREFIX):
        return None
    tok = db.scalar(select(ApiToken).where(ApiToken.token_hash == hash_token(raw)))
    if tok is None or tok.revoked_at is not None:
        return None
    ts = now()
    if tok.expires_at is not None and _aware(tok.expires_at) <= ts:
        return None
    user = db.get(User, tok.user_id)
    if user is None or not user.is_active:
        return None
    if tok.last_used_at is None or ts - _aware(tok.last_used_at) > _LAST_USED_GRANULARITY:
        tok.last_used_at = ts
        db.commit()
    return tok, user


def _aware(dt):
    from datetime import timezone

    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
