"""Zeitleiste: Überschriften mit Zeitangabe am Anfang werden aus Dateien in ``project_timeline`` indiziert.

Schreibweisen (Groß-/Kleinschreibung egal, Überschriften der Ebenen 1-6, Code-Blöcke werden ignoriert)::

    ## 06:30 Anmarsch                      Uhrzeit, Tag 1
    ## Tag 2 · 06:30 Angriff               Uhrzeit an Tag 2   (auch "Day 2 06:30", "T2 06:30")
    ## T+01:30 Feindkontakt                relativ zum Missionsbeginn (hh:mm)
    ## H+90 Rückzug                        relativ, Minuten (auch T+90, H+1:30)

Absolute Einträge sortieren nach (Tag, Minuten) vor den relativen (nach Minuten). Die Funktionen
committen nicht. Spezifikation: docs/MISSIONSBAU-WERKZEUGE.md.
"""
from __future__ import annotations

import re
from collections.abc import Iterable

from sqlalchemy import delete as sa_delete
from sqlalchemy.orm import Session

from ..models import ProjectDoc, ProjectTimelineEntry

_HEADING = re.compile(r"^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*$")
_FENCE = re.compile(r"^ {0,3}(```|~~~)")
_SEP = r"[ \t]*[·\-–—:|,]?[ \t]*"
_REL = re.compile(r"^[th][ \t]*\+[ \t]*(\d{1,4})(?::(\d{2}))?(?!\d)" + _SEP + r"(.*)$", re.I)
_DAY = re.compile(r"^(?:tag|day|t)[ \t]*(\d{1,3})" + _SEP + r"(\d{1,2}):(\d{2})(?!\d)(?:[ \t]*uhr)?" + _SEP + r"(.*)$", re.I)
_TIME = re.compile(r"^(\d{1,2}):(\d{2})(?!\d)(?:[ \t]*uhr)?" + _SEP + r"(.*)$", re.I)
_MAX_ENTRIES_PER_DOC = 500


def _parse_title(text: str) -> tuple[int | None, int, bool, str] | None:
    """-> (Tag oder None bei relativ, Minuten, relativ, Rest-Titel) oder None ohne Zeitangabe."""
    m = _REL.match(text)
    if m:
        hours_or_min, mm, rest = int(m.group(1)), m.group(2), m.group(3)
        if mm is None:  # H+90 / T+90 = Minuten
            return None, hours_or_min, True, rest
        if int(mm) < 60:  # T+01:30 = Stunden:Minuten
            return None, hours_or_min * 60 + int(mm), True, rest
        return None
    m = _DAY.match(text)
    if m:
        day, h, mi = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if day >= 1 and h < 24 and mi < 60:
            return day, h * 60 + mi, False, m.group(4)
        return None
    m = _TIME.match(text)
    if m:
        h, mi = int(m.group(1)), int(m.group(2))
        if h < 24 and mi < 60:
            return 1, h * 60 + mi, False, m.group(3)
    return None


def parse(content: str) -> list[dict]:
    """Zeitleisten-Überschriften eines Markdown-Textes: ``heading``, ``level``, ``day`` (None bei
    relativ), ``minutes``, ``relative``, ``position`` (Zeilennummer, 1-basiert), ``ord_key``."""
    out: list[dict] = []
    fence: str | None = None
    for no, line in enumerate((content or "").splitlines(), start=1):
        f = _FENCE.match(line)
        if f:
            if fence is None:
                fence = f.group(1)
            elif f.group(1) == fence:
                fence = None
            continue
        if fence is not None:
            continue
        h = _HEADING.match(line)
        if not h:
            continue
        title = re.sub(r"[ \t]+#+$", "", h.group(2)).strip()
        parsed = _parse_title(title)
        if parsed is None:
            continue
        day, minutes, relative, rest = parsed
        out.append({
            "heading": (rest.strip() or title)[:200], "level": len(h.group(1)), "day": day,
            "minutes": minutes, "relative": relative, "position": no,
            "ord_key": f"1{0:03d}{minutes:07d}" if relative else f"0{day:03d}{minutes:07d}",
        })
        if len(out) >= _MAX_ENTRIES_PER_DOC:
            break
    return out


def rebuild(db: Session, doc: ProjectDoc) -> None:
    """Zeitleisten-Zeilen einer Datei neu aufbauen (Ordner haben keine)."""
    db.execute(sa_delete(ProjectTimelineEntry).where(ProjectTimelineEntry.doc_id == doc.id))
    if doc.kind != "doc":
        return
    for e in parse(doc.content):
        db.add(ProjectTimelineEntry(project_id=doc.project_id, doc_id=doc.id, space=doc.space, **e))


def drop(db: Session, doc_ids: Iterable[str]) -> None:
    ids = list(doc_ids)
    if ids:
        db.execute(sa_delete(ProjectTimelineEntry).where(ProjectTimelineEntry.doc_id.in_(ids)))
