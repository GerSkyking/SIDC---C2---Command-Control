"""Eigene API-Tokens verwalten (Erstellen/Auflisten/Widerrufen).

Bewusst nur mit Cookie-Session erreichbar (``CurrentUser``): Ein API-Token kann sich
nie selbst verlängern oder neue Tokens ausstellen."""
from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from .. import audit
from ..deps import CurrentUser, DbDep
from ..models import ApiToken, now
from ..tokens import ALL_SCOPES, MAX_TOKENS_PER_USER, TOKEN_PREFIX, hash_token, new_raw_token

router = APIRouter(prefix="/api/tokens", tags=["tokens"])


class TokenCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    expires_days: int | None = Field(default=None, ge=1, le=3650)  # None = läuft nicht ab


class TokenOut(BaseModel):
    id: str
    name: str
    prefix: str
    scopes: list[str]
    created_at: str | None = None
    last_used_at: str | None = None
    expires_at: str | None = None
    revoked: bool = False


class TokenCreatedOut(TokenOut):
    token: str  # Klartext — nur in dieser einen Antwort


def _iso(d) -> str | None:
    return d.isoformat() if d else None


def _out(t: ApiToken) -> dict:
    return {
        "id": t.id, "name": t.name, "prefix": t.prefix, "scopes": list(t.scopes or []),
        "created_at": _iso(t.created_at), "last_used_at": _iso(t.last_used_at),
        "expires_at": _iso(t.expires_at), "revoked": t.revoked_at is not None,
    }


@router.get("", response_model=list[TokenOut])
def list_tokens(user: CurrentUser, db: DbDep) -> list[dict]:
    rows = db.scalars(
        select(ApiToken).where(ApiToken.user_id == user.id).order_by(ApiToken.created_at.desc())
    )
    return [_out(t) for t in rows]


@router.post("", response_model=TokenCreatedOut, status_code=status.HTTP_201_CREATED)
def create_token(body: TokenCreateIn, request: Request, user: CurrentUser, db: DbDep) -> dict:
    name = "".join(c for c in body.name.strip() if c.isprintable())[:64]
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Name fehlt")
    active = db.scalar(
        select(func.count()).select_from(ApiToken).where(
            ApiToken.user_id == user.id, ApiToken.revoked_at.is_(None)
        )
    )
    if (active or 0) >= MAX_TOKENS_PER_USER:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Maximal {MAX_TOKENS_PER_USER} aktive Tokens")

    raw = new_raw_token()
    tok = ApiToken(
        user_id=user.id, name=name, token_hash=hash_token(raw), prefix=raw[: len(TOKEN_PREFIX) + 6],
        scopes=list(ALL_SCOPES),
        expires_at=(now() + timedelta(days=body.expires_days)) if body.expires_days else None,
    )
    db.add(tok)
    db.commit()
    audit.record(db, "token.create", user_id=user.id, target_type="api_token", target_id=tok.id,
                 request=request, name=name)
    return {**_out(tok), "token": raw}


@router.delete("/{token_id}")
def revoke_token(token_id: str, request: Request, user: CurrentUser, db: DbDep) -> dict:
    tok = db.get(ApiToken, token_id)
    if tok is None or tok.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Token nicht gefunden")
    if tok.revoked_at is None:
        tok.revoked_at = now()
        db.commit()
        audit.record(db, "token.revoke", user_id=user.id, target_type="api_token", target_id=tok.id,
                     request=request, name=tok.name)
    return {"ok": True}
