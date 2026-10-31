"""Pydantic-Schemas für die HTTP-API."""
from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    username: str
    display_name: str = ""
    role: str
    can_create_plans: bool
    is_mission_builder: bool = False
    is_zeus: bool = False


class MeOut(UserOut):
    can_create_plans_effective: bool
    is_mission_builder_effective: bool = False
    is_zeus_effective: bool = False
    ui_settings: dict = {}


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
    imported_at: datetime | None = None  # ändert sich bei jedem (Re-)Import -> Cache-Version


class MapSourceIn(BaseModel):
    url: str                       # z. B. https://git.jensr.de/root/ReforgerMapData
    name: str = ""
    token: str | None = None
    subpath: str = ""
    ref: str = ""


class MapSourceOut(BaseModel):
    id: str
    kind: str
    name: str
    base_url: str
    repo: str
    subpath: str
    ref: str
    has_token: bool


class MapSourceFile(BaseModel):
    name: str
    size: int
    download_url: str
    path: str = ""


class SourceImportIn(BaseModel):
    path: str          # Datei-Pfad im Repo (relativ), z. B. "catalog/SIDC_Translations.xlsx"
    target: str         # Katalog-Schlüssel: all-markers|quick-menu|modifiers|phaseline-style|translations


class MapImportFromSourceIn(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{1,63}$")
    name: str
    source_id: str
    file: str


# ─── Pläne ─────────────────────────────────────────────────────────────────

class PlanCreateIn(BaseModel):
    name: str
    map_id: str
    folder_id: str | None = None
    project_id: str | None = None


class PlanProjectIn(BaseModel):
    project_id: str | None = None  # None = aus dem Projekt herauslösen


class PlanPatchIn(BaseModel):
    name: str | None = None
    h_hour: datetime | None = None


class PlanOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    map_id: str
    folder_id: str | None = None
    project_id: str | None = None
    ordering: int = 0
    created_at: datetime
    updated_at: datetime
    h_hour: datetime | None = None


class PlanMoveIn(BaseModel):
    folder_id: str | None = None  # None = oberste Ebene
    ordering: int | None = None


class FolderIn(BaseModel):
    name: str
    parent_id: str | None = None
    project_id: str | None = None


class FolderPatchIn(BaseModel):
    name: str | None = None
    parent_id: str | None = None
    ordering: int | None = None
    move_to_root: bool = False  # parent_id=None sonst = "nicht ändern"


class PlanListItem(PlanOut):
    level: str  # effektives Recht des Anfragenden


class PlanProjectListItem(PlanListItem):
    project_name: str = ""


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
    folder_id: str | None = None


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
    tint: str = ""


class StrokeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    kind: str
    points: list
    color: int
    width: float


# ─── Missionsbau-Projekte ──────────────────────────────────────────────────

from typing import Literal  # noqa: E402

ProjectRole = Literal["viewer", "editor", "owner"]
DocSpace = Literal["public", "builder"]
NoteColor = Literal["yellow", "green", "blue", "pink", "orange", "gray"]
TaskStatus = Literal["open", "doing", "review", "done"]
TaskPriority = Literal["low", "normal", "high"]


class ProjectCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=20000)
    folder_id: str | None = None


class ProjectPatchIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=20000)
    archived: bool | None = None
    folder_id: str | None = None  # nur wirksam, wenn im Body enthalten (null = oberste Ebene)


class ProjectFolderIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    parent_id: str | None = None


class ProjectFolderPatchIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    parent_id: str | None = None
    move_to_root: bool = False
    ordering: int | None = None


class ProjectMemberIn(BaseModel):
    subject_type: Literal["user", "group"]
    subject_id: str = Field(min_length=1, max_length=32)
    role: ProjectRole


class DocCreateIn(BaseModel):
    space: DocSpace
    parent_id: str | None = None
    kind: Literal["folder", "doc"]
    name: str = Field(min_length=1, max_length=200)
    content: str = Field(default="", max_length=200000)


class DocPatchIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    content: str | None = Field(default=None, max_length=200000)
    parent_id: str | None = None  # nur mit gesetztem Feld (model_fields_set): null = Wurzel
    ordering: int | None = None
    expected_updated_at: datetime | None = None


class ImagePatchIn(BaseModel):
    caption: str | None = Field(default=None, max_length=2000)
    note: str | None = Field(default=None, max_length=20000)


class NoteCreateIn(BaseModel):
    text: str = Field(default="", max_length=4000)
    color: NoteColor = "yellow"
    x: float = 0
    y: float = 0
    w: float = 220
    h: float = 160
    task_id: str | None = None
    user_id: str | None = None


class NotePatchIn(BaseModel):
    text: str | None = Field(default=None, max_length=4000)
    color: NoteColor | None = None
    x: float | None = None
    y: float | None = None
    w: float | None = None
    h: float | None = None
    task_id: str | None = None  # "" = Verknüpfung entfernen
    user_id: str | None = None  # "" = Verknüpfung entfernen


class NoteLinkIn(BaseModel):
    from_id: str
    to_id: str


class TaskCreateIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=20000)
    status: TaskStatus = "open"
    priority: TaskPriority = "normal"
    assignee_id: str | None = None
    due_date: date | None = None
    plan_id: str | None = None
    doc_id: str | None = None


class TaskPatchIn(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=20000)
    status: TaskStatus | None = None
    priority: TaskPriority | None = None
    assignee_id: str | None = None   # null setzt zurück (nur wenn Feld gesendet)
    due_date: date | None = None
    plan_id: str | None = None
    doc_id: str | None = None


class CommentIn(BaseModel):
    text: str = Field(min_length=1, max_length=5000)


class TaskMoveIn(BaseModel):
    status: TaskStatus
    ordering: int = Field(default=0, ge=0, le=100000)
