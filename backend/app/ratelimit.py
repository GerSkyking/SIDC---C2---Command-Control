"""Sehr einfacher In-Process-Ratelimiter für Login-Versuche.

Zwei Schranken pro 60-s-Fenster:
  * je (IP, Username): 8  — bremst gezieltes Passwort-Raten
  * je IP:            30  — bremst Passwort-Spraying (viele Usernamen, eine IP)

Reicht für einen Single-Worker-Deploy hinter dem Proxy. Bei mehreren Workern
später auf Redis umstellen (INCR + EXPIRE).
"""
from __future__ import annotations

import time
from collections import defaultdict

_WINDOW = 60.0
_MAX_USER = 8
_MAX_IP = 30
_hits: dict[str, list[float]] = defaultdict(list)


def _hit(key: str, limit: int) -> bool:
    now = time.monotonic()
    bucket = [t for t in _hits[key] if now - t < _WINDOW]
    bucket.append(now)
    _hits[key] = bucket
    return len(bucket) <= limit


def check_and_hit(key: str, ip: str | None = None) -> bool:
    """True = erlaubt. Zählt den Versuch mit (beide Schranken)."""
    ok_user = _hit(f"u:{key}", _MAX_USER)
    ok_ip = _hit(f"i:{ip}", _MAX_IP) if ip else True
    return ok_user and ok_ip


def reset(key: str) -> None:
    _hits.pop(f"u:{key}", None)
