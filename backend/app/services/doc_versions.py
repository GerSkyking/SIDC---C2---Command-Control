"""Versionsverlauf von Dateien: vor einer Inhaltsänderung wird der bisherige Stand gesichert.

Regeln (docs/MISSIONSBAU-WERKZEUGE.md): Ist der letzte Eintrag vom selben Nutzer und jünger als
5 Minuten, wird nicht erneut gesichert (Autosave erzeugt sonst Dutzende Stände); höchstens
50 Stände je Datei, die ältesten fallen weg. Leere Stände werden nicht gesichert. Kein commit –
läuft in der Transaktion der aufrufenden Aktion.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import ProjectDoc, ProjectDocVersion, now

MAX_VERSIONS = 50
COALESCE_WINDOW = timedelta(minutes=5)


def _naive(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc).replace(tzinfo=None) if dt.tzinfo else dt


def snapshot(db: Session, d: ProjectDoc, old_name: str, old_content: str, user_id: str, force: bool = False) -> bool:
    """Sichert (old_name, old_content) als Version von ``d``. ``force`` ignoriert die 5-Minuten-Regel
    (Wiederherstellen). True, wenn ein Eintrag entstanden ist."""
    if not old_content:
        return False
    if not force:
        last = db.scalar(select(ProjectDocVersion).where(ProjectDocVersion.doc_id == d.id)
                         .order_by(ProjectDocVersion.created_at.desc()).limit(1))
        if last is not None and last.saved_by == user_id and _naive(now()) - _naive(last.created_at) < COALESCE_WINDOW:
            return False
    db.add(ProjectDocVersion(doc_id=d.id, project_id=d.project_id, name=old_name, content=old_content,
                             saved_by=user_id))
    db.flush()
    extra = db.scalar(select(func.count(ProjectDocVersion.id)).where(ProjectDocVersion.doc_id == d.id)) - MAX_VERSIONS
    if extra > 0:
        old_ids = list(db.scalars(select(ProjectDocVersion.id).where(ProjectDocVersion.doc_id == d.id)
                                  .order_by(ProjectDocVersion.created_at).limit(extra)))
        db.execute(sa_delete(ProjectDocVersion).where(ProjectDocVersion.id.in_(old_ids)))
    return True
