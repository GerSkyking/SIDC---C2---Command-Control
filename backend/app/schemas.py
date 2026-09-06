"""Pydantic-Schemas für die HTTP-API."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class LoginIn(BaseModel):
    username: str
    password: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    username: str
    role: str
    can_create_plans: bool


class MeOut(UserOut):
    can_create_plans_effective: bool


# ─── Karten ────────────────────────────────────────────────────────────────

class MapImportIn(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{1,63}$")
    name: str
    url: str


class MapOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    status: str
    error: str | None = None
    meta: dict = {}


# ─── Pläne ─────────────────────────────────────────────────────────────────

class PlanCreateIn(BaseModel):
    name: str
    map_id: str


class PlanPatchIn(BaseModel):
    name: str | None = None


class PlanOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    map_id: str
    created_at: datetime
    updated_at: datetime


class PlanListItem(PlanOut):
    level: str  # effektives Recht des Anfragenden


class ACLEntryIn(BaseModel):
    subject_type: str = Field(pattern=r"^(user|group)$")
    subject_id: str
    level: str = Field(pattern=r"^(viewer|editor|owner)$")
    can_place: bool = True
    can_move: bool = True
    can_delete: bool = True
    can_draw: bool = True


class ACLOut(ACLEntryIn):
    model_config = ConfigDict(from_attributes=True)
    id: str


class ACLCandidate(BaseModel):
    subject_type: str
    subject_id: str
    name: str


class PlanCloneIn(BaseModel):
    name: str
    copy_acl: bool = False


class VersionCreateIn(BaseModel):
    label: str = ""


class MarkerOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    sidc: str
    world_x: float
    world_y: float
    rotation_degrees: int
    unit_text: str
    ai_text: str
    channel: str
    locked: bool
    timestamp_visible: bool
    linked_group_id: int
    point_index: int
    line_color: int
    line_width: float


class StrokeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    kind: str
    points: list
    color: int
    width: float
