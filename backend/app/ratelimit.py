"""Sehr einfacher In-Process-Ratelimiter (Sliding Window).

Reicht für einen Single-Worker-Deploy hinter dem Proxy. Bei mehreren Workern
später auf Redis umstellen (INCR + EXPIRE).
"""
from __future__ import annotations

import time
from collections import defaultdict

_hits: dict[str, list[float]] = defaultdict(list)
_windows: dict[str, float] = {}   # Fenster je Key, damit abgelaufene Keys entfernt werden können
_SWEEP_EVERY = 60.0
_last_sweep = 0.0


def _sweep(now: float) -> None:
    """Keys (z. B. ip:username) ohne Treffer im eigenen Fenster entfernen, sonst wächst _hits unbegrenzt."""
    global _last_sweep
    if now - _last_sweep < _SWEEP_EVERY:
        return
    _last_sweep = now
    for k in [k for k, b in _hits.items() if not b or now - b[-1] >= _windows.get(k, 3600.0)]:
        _hits.pop(k, None)
        _windows.pop(k, None)


def _hit(key: str, limit: int, window: float) -> bool:
    now = time.monotonic()
    _sweep(now)
    _windows[key] = window
    bucket = [t for t in _hits[key] if now - t < window]
    bucket.append(now)
    _hits[key] = bucket
    return len(bucket) <= limit


# ─── Login: zwei Schranken pro 60-s-Fenster ────────────────────────────────
#   * je (IP, Username): 8  — bremst gezieltes Passwort-Raten
#   * je IP:            30  — bremst Passwort-Spraying (viele Usernamen, eine IP)
_LOGIN_WINDOW = 60.0
_LOGIN_MAX_USER = 8
_LOGIN_MAX_IP = 30


def check_and_hit(key: str, ip: str | None = None) -> bool:
    """True = erlaubt. Zählt den Login-Versuch mit (beide Schranken)."""
    ok_user = _hit(f"u:{key}", _LOGIN_MAX_USER, _LOGIN_WINDOW)
    ok_ip = _hit(f"i:{ip}", _LOGIN_MAX_IP, _LOGIN_WINDOW) if ip else True
    return ok_user and ok_ip


def reset(key: str) -> None:
    _hits.pop(f"u:{key}", None)
    _windows.pop(f"u:{key}", None)


# ─── Generischer Limiter für andere Endpunkte (z. B. Share-Link-Erstellung) ─

def hit_limit(key: str, limit: int, window_s: float) -> bool:
    """True = erlaubt (und gezählt). False = Limit für dieses Fenster erreicht —
    der Aufruf wird trotzdem NICHT gezählt (kein Bonus-Versuch durchs Wiederholen)."""
    now = time.monotonic()
    _sweep(now)
    _windows[key] = window_s
    bucket = [t for t in _hits[key] if now - t < window_s]
    if len(bucket) >= limit:
        _hits[key] = bucket
        return False
    bucket.append(now)
    _hits[key] = bucket
    return True
