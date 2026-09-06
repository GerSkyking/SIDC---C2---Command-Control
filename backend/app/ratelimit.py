"""Sehr einfacher In-Process-Ratelimiter (8 Fehlversuche / 60s je Schlüssel).

Reicht für einen Single-Worker-Deploy hinter dem Proxy. Bei mehreren Workern
später auf Redis umstellen (INCR + EXPIRE).
"""
from __future__ import annotations

import time
from collections import defaultdict

_WINDOW = 60.0
_MAX = 8
_hits: dict[str, list[float]] = defaultdict(list)


def check_and_hit(key: str) -> bool:
    """True = erlaubt. Zählt den Versuch mit."""
    now = time.monotonic()
    bucket = [t for t in _hits[key] if now - t < _WINDOW]
    bucket.append(now)
    _hits[key] = bucket
    return len(bucket) <= _MAX


def reset(key: str) -> None:
    _hits.pop(key, None)
