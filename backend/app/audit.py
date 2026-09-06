"""Audit-Log — wer hat wann was gemacht."""
from __future__ import annotations

import logging

from fastapi import Request
from sqlalchemy.orm import Session

from .models import AuditLog

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
