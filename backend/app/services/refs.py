"""Verknüpfungs-Codes in Texten: {{doc|task|plan|note|img:<32hex>}} und {{place:<karte>:<ortsname>}}.

Der Index ``project_refs`` hält je Quelle (Datei, Aufgabe, Notiz) die enthaltenen Codes und wird
beim Speichern der Quelle komplett neu aufgebaut. Ziele werden beim Auflösen auf Existenz und
Rechte geprüft (kein ON DELETE für Ziele nötig). Die Funktionen committen nicht – sie laufen in
der Transaktion der aufrufenden Aktion. Spezifikation: docs/MISSIONSBAU-WERKZEUGE.md.
"""
from __future__ import annotations

import re
from collections.abc import Iterable

from sqlalchemy import delete as sa_delete
from sqlalchemy.orm import Session

from ..models import ProjectRef

ID_TYPES = ("doc", "task", "plan", "note", "img")
_CODE = re.compile(r"\{\{(doc|task|plan|note|img):([0-9a-f]{32})\}\}")
_PLACE = re.compile(r"\{\{place:([a-z0-9][a-z0-9_-]{1,63}):([^{}\n]{1,200}?)\}\}")
_MAX_REFS_PER_SOURCE = 500


def extract(*texts: str) -> list[tuple[str, str]]:
    """Alle Codes (Typ, Ziel-ID) in Reihenfolge des ersten Auftretens, ohne Duplikate.
    Für ``place`` ist die Ziel-ID ``<karte>:<ortsname>``."""
    seen: set[tuple[str, str]] = set()
    out: list[tuple[str, str]] = []
    for text in texts:
        if not text:
            continue
        hits = [(m.start(), m.group(1), m.group(2)) for m in _CODE.finditer(text)]
        hits += [(m.start(), "place", f"{m.group(1)}:{m.group(2).strip()}") for m in _PLACE.finditer(text)]
        for _, typ, tid in sorted(hits):
            if (typ, tid) not in seen:
                seen.add((typ, tid))
                out.append((typ, tid))
    return out[:_MAX_REFS_PER_SOURCE]


def rebuild(db: Session, pid: str, source_type: str, source_id: str, *texts: str) -> None:
    """Index der Quelle neu aufbauen (alte Zeilen löschen, aktuelle Codes eintragen)."""
    db.execute(sa_delete(ProjectRef).where(
        ProjectRef.source_type == source_type, ProjectRef.source_id == source_id))
    for typ, tid in extract(*texts):
        db.add(ProjectRef(project_id=pid, source_type=source_type, source_id=source_id,
                          target_type=typ, target_id=tid))


def drop(db: Session, source_type: str, source_ids: Iterable[str]) -> None:
    """Quell-Zeilen entfernen (Quelle wurde gelöscht)."""
    ids = list(source_ids)
    if ids:
        db.execute(sa_delete(ProjectRef).where(
            ProjectRef.source_type == source_type, ProjectRef.source_id.in_(ids)))
