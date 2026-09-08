"""SIDC-Statusstelle (APP6-D Stelle 7, 0-indexiert 6) ↔ ORBAT-Knotenstatus.

`0` einsatzbereit · `3` beschädigt · `4` zerstört (siehe frontend/src/sidc/sidc.ts).
"""
from __future__ import annotations

_DIGIT_TO_STATUS = {"3": "damaged", "4": "destroyed"}
_STATUS_TO_DIGIT = {"active": "0", "damaged": "3", "destroyed": "4"}

# Fallback-Symbol für Spieler, wenn der Typ nicht freigegeben ist: Hostile, unbekannt.
GENERIC_HOSTILE_SIDC = "100600000000000000000000000000"


def status_from_sidc(sidc: str) -> str:
    if not sidc or len(sidc) < 7:
        return "active"
    return _DIGIT_TO_STATUS.get(sidc[6], "active")


def sidc_with_status(sidc: str, status: str) -> str:
    s = (sidc or "").ljust(30, "0")[:30]
    return s[:6] + _STATUS_TO_DIGIT.get(status, "0") + s[7:]


# ─── Zugehörigkeit (APP6-D Identitätsstelle, 0-indexiert 3) ─────────────────

AFFIL_DIGIT = {"friend": "3", "hostile": "6", "neutral": "4", "unknown": "1"}


def sidc_with_affiliation(sidc: str, affiliation: str) -> str:
    s = (sidc or "").ljust(30, "0")[:30]
    return s[:3] + AFFIL_DIGIT.get(affiliation, "1") + s[4:]
