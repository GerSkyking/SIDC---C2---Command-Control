"""Passwort-Hashing (argon2) und signierte Session-Cookies (stateless, itsdangerous)."""
from __future__ import annotations

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pwdlib import PasswordHash

from .config import get_settings

SESSION_COOKIE = "sidc_session"
_SALT = "sidc-session-v1"

_pwd = PasswordHash.recommended()
_settings = get_settings()
_serializer = URLSafeTimedSerializer(_settings.resolved_secret_key(), salt=_SALT)

MIN_PASSWORD_LEN = 12


def hash_password(plain: str) -> str:
    return _pwd.hash(plain)


def verify_password(plain: str, hashed: str | None) -> bool:
    if not hashed:
        return False
    return _pwd.verify(plain, hashed)


def issue_session(user_id: str, epoch: int = 0) -> str:
    return _serializer.dumps({"uid": user_id, "e": epoch})


def read_session(token: str) -> tuple[str, int] | None:
    """(user_id, session_epoch) oder None. Epoch fehlt bei Alt-Cookies -> 0."""
    max_age = _settings.session_ttl_days * 86400
    try:
        data = _serializer.loads(token, max_age=max_age)
    except (BadSignature, SignatureExpired):
        return None
    uid = data.get("uid")
    if not uid:
        return None
    return uid, int(data.get("e", 0))


def origin_allowed(origin: str | None, host: str | None) -> bool:
    """CSWSH-Schutz für WebSockets: kein Origin (nicht-Browser-Client) ist ok,
    sonst muss der Origin-Host dem Ziel-Host entsprechen (same-origin-Deploy)."""
    if not origin:
        return True
    try:
        from urllib.parse import urlparse

        return urlparse(origin).netloc.lower() == (host or "").lower()
    except ValueError:
        return False


def cookie_is_secure(request_scheme: str, forwarded_proto: str | None) -> bool:
    mode = _settings.cookie_secure
    if mode == "true":
        return True
    if mode == "false":
        return False
    proto = (forwarded_proto or request_scheme or "").lower()
    return proto == "https"
