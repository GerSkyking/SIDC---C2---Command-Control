"""Persönliche Marker-Favoriten."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func, select

from ..deps import CurrentUser, DbDep
from ..models import Favorite

router = APIRouter(prefix="/api/favorites", tags=["favorites"])


class FavoriteIn(BaseModel):
    label: str
    sidc: str
    rotation_degrees: int = -1
    unit_text: str = ""
    ai_text: str = ""


class FavoriteOut(FavoriteIn):
    id: str


def _out(f: Favorite) -> FavoriteOut:
    return FavoriteOut(
        id=f.id, label=f.label, sidc=f.sidc, rotation_degrees=f.rotation_degrees,
        unit_text=f.unit_text, ai_text=f.ai_text,
    )


@router.get("", response_model=list[FavoriteOut])
def list_favorites(user: CurrentUser, db: DbDep) -> list[FavoriteOut]:
    rows = db.scalars(
        select(Favorite).where(Favorite.user_id == user.id).order_by(Favorite.ordering, Favorite.created_at)
    )
    return [_out(f) for f in rows]


@router.post("", response_model=FavoriteOut, status_code=status.HTTP_201_CREATED)
def add_favorite(body: FavoriteIn, user: CurrentUser, db: DbDep) -> FavoriteOut:
    nxt = db.scalar(select(func.coalesce(func.max(Favorite.ordering), 0)).where(Favorite.user_id == user.id))
    f = Favorite(user_id=user.id, ordering=(nxt or 0) + 1, **body.model_dump())
    db.add(f)
    db.commit()
    return _out(f)


@router.delete("/{fav_id}")
def delete_favorite(fav_id: str, user: CurrentUser, db: DbDep) -> dict:
    f = db.get(Favorite, fav_id)
    if f is None or f.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    db.delete(f)
    db.commit()
    return {"ok": True}
