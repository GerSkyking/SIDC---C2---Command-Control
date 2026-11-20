"""Passwort-Hashing (argon2) und signierte Session-Cookies (stateless, itsdangerous)."""
from __future__ import annotations

import time

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


def read_session_aged(token: str) -> tuple[str, int, float] | None:
    """(user_id, session_epoch, alter_in_sekunden) oder None. Epoch fehlt bei Alt-Cookies -> 0."""
    max_age = _settings.session_ttl_seconds()
    try:
        data, issued = _serializer.loads(token, max_age=max_age, return_timestamp=True)
    except (BadSignature, SignatureExpired):
        return None
    uid = data.get("uid")
    if not uid:
        return None
    return uid, int(data.get("e", 0)), max(0.0, time.time() - issued.timestamp())


def read_session(token: str) -> tuple[str, int] | None:
    """(user_id, session_epoch) oder None. Epoch fehlt bei Alt-Cookies -> 0."""
    sess = read_session_aged(token)
    return (sess[0], sess[1]) if sess else None


def set_session_cookie(request, response, user_id: str, epoch: int = 0) -> None:
    """Setzt das Sitzungs-Cookie neu (Login und gleitende Verlängerung)."""
    response.set_cookie(
        SESSION_COOKIE,
        issue_session(user_id, epoch),
        max_age=_settings.session_ttl_seconds(),
        httponly=True,
        samesite="lax",
        secure=cookie_is_secure(request.url.scheme, request.headers.get("x-forwarded-proto")),
        path="/",
    )


def needs_renewal(age_seconds: float) -> bool:
    """Gleitende Sitzung: nach einem Viertel der Laufzeit wird das Cookie erneuert."""
    return age_seconds >= _settings.session_ttl_seconds() / 4


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
