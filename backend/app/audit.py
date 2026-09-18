"""Audit-Log — wer hat wann was gemacht."""
from __future__ import annotations

import logging
from datetime import timedelta

from fastapi import Request
from sqlalchemy import delete
from sqlalchemy.orm import Session

from .models import AuditLog, now

log = logging.getLogger("sidc.audit")


def client_ip(request: Request | None) -> str | None:
    if request is None:
        return None
    return request.client.host if request.client else None


def record(
    db: Session,
    action: str,
    *,
    user_id: str | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    request: Request | None = None,
    **detail: object,
) -> None:
    """Bewusst tolerant — ein Audit-Fehler darf die eigentliche Aktion nie kippen."""
    try:
        if request is not None:
            detail.setdefault("ip", client_ip(request))
        db.add(
            AuditLog(
                user_id=user_id,
                action=action,
                target_type=target_type,
                target_id=target_id,
                detail={k: v for k, v in detail.items() if v is not None},
            )
        )
        db.commit()
    except Exception:  # noqa: BLE001
        log.exception("Audit-Eintrag '%s' fehlgeschlagen", action)
        db.rollback()


def purge_old(db: Session, retention_days: int) -> int:
    """Löscht Audit-Log-Einträge älter als retention_days. 0/negativ = no-op.
    Gibt die Anzahl gelöschter Zeilen zurück."""
    if retention_days <= 0:
        return 0
    cutoff = now() - timedelta(days=retention_days)
    result = db.execute(delete(AuditLog).where(AuditLog.ts < cutoff))
    db.commit()
    return result.rowcount or 0
