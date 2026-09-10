"""ORM-Modelle. Marker-Felder spiegeln ATAKmaps (server/app.py: SidcMarkerCreate)."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

from .db import Base, UuidPk, uuid_str


def now() -> datetime:
    return datetime.now(timezone.utc)


# ─── Identität / Rechte ─────────────────────────────────────────────────────

class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(UuidPk, primary_key=True, default=uuid_str)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    # Frei änderbarer Anzeigename; wird anderen Nutzern statt username gezeigt.
    display_name: Mapped[str] = mapped_column(String(64), default="", server_default="")
    password_hash: Mapped[str | None] = mapped_column(String(255))  # None = nur OIDC
    role: Mapped[str] = mapped_column(String(16), default="user")   # 'admin' | 'user'
    can_create_plans: Mapped[bool] = mapped_column(Boolean, default=False)
    is_mission_builder: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Bei Passwortwechsel / "überall abmelden" hochgezählt -> alte Session-Cookies ungültig.
    session_epoch: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    ui_settings: Mapped[dict] = mapped_column(JSON, default=dict)  # Keybinds, Theme … (pro Nutzer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    groups: Mapped[list["Group"]] = relationship(secondary="group_members", back_populates="members")

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    @property
    def label(self) -> str:
        """Für andere Nutzer sichtbarer Name (Anzeigename, sonst Login-Name)."""
        return self.display_name or self.username


class OidcIdentity(Base):
    __tablename__ = "oidc_identities"
    __table_args__ = (UniqueConstraint("issuer", "subject", name="uq_oidc_issuer_subject"),)

    id: Mapped[str] = mapped_column(UuidPk, primary_key=True, default=uuid_str)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    issuer: Mapped[str] = mapped_column(String(255))
    subject: Mapped[str] = mapped_column(String(255))


class Group(Base):
    __tablename__ = "groups"

    id: Mapped[str] = mapped_column(UuidPk, primary_key=True, default=uuid_str)
    name: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    can_create_plans: Mapped[bool] = mapped_column(Boolean, default=False)
    is_mission_builder: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    members: Mapped[list[User]] = relationship(secondary="group_members", back_populates="groups")


class GroupMember(Base):
    __tablename__ = "group_members"

    group_id: Mapped[str] = mapped_column(ForeignKey("groups.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)


# ─── Karten ─────────────────────────────────────────────────────────────────

class Map(Base):
    __tablename__ = "maps"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # slug / Verzeichnisname
    name: Mapped[str] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(16), default="importing")  # importing|ready|error
    source_url: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    meta: Mapped[dict] = mapped_column(JSON, default=dict)  # bounds, min/maxzoom …
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    imported_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class MapSource(Base):
    """Externe Bezugsquelle für Mappack-ZIPs (aktuell: Gitea-Repo). Admin trägt
    die Repo-URL ein; das Backend listet die ``*.zip`` über die Gitea-API."""

    __tablename__ = "map_sources"

    id: Mapped[str] = mapped_column(UuidPk, primary_key=True, default=uuid_str)
    kind: Mapped[str] = mapped_column(String(16), default="gitea")
    name: Mapped[str] = mapped_column(String(128), default="")
    base_url: Mapped[str] = mapped_column(String(512))   # https://git.jensr.de
    repo: Mapped[str] = mapped_column(String(256))        # owner/name
    subpath: Mapped[str] = mapped_column(String(256), default="")
    ref: Mapped[str] = mapped_column(String(128), default="")  # branch/tag, "" = default
    token: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


# ─── Pläne ──────────────────────────────────────────────────────────────────

class PlanFolder(Base):
    """Ordner zum Gruppieren von Plänen. parent_id NULL = oberste Ebene.
    Organisationsstruktur, für alle angemeldeten Nutzer sichtbar."""

    __tablename__ = "plan_folders"

    id: Mapped[str] = mapped_column(UuidPk, primary_key=True, default=uuid_str)
    name: Mapped[str] = mapped_column(String(128))
    parent_id: Mapped[str | None] = mapped_column(
        ForeignKey("plan_folders.id", ondelete="SET NULL"), index=True, nullable=True
    )
    ordering: Mapped[int] = mapped_column(Integer, default=0)
    created_by: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Plan(Base):
    __tablename__ = "plans"

    id: Mapped[str] = mapped_column(UuidPk, primary_key=True, default=uuid_str)
    name: Mapped[str] = mapped_column(String(128))
    map_id: Mapped[str] = mapped_column(ForeignKey("maps.id", ondelete="RESTRICT"), index=True)
    folder_id: Mapped[str | None] = mapped_column(
        ForeignKey("plan_folders.id", ondelete="SET NULL"), index=True, nullable=True
    )
    ordering: Mapped[int] = mapped_column(Integer, default=0)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    h_hour: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # Operationsbeginn (Zeitstrahl)

    acl: Mapped[list["PlanACL"]] = relationship(
        back_populates="plan", cascade="all, delete-orphan"
    )


class PlanACL(Base):
    __tablename__ = "plan_acl"
    __table_args__ = (
        UniqueConstraint("plan_id", "subject_type", "subject_id", name="uq_plan_acl_subject"),
    )

    id: Mapped[str] = mapped_column(UuidPk, primary_key=True, default=uuid_str)
    plan_id: Mapped[str] = mapped_column(ForeignKey("plans.id", ondelete="CASCADE"), index=True)
    subject_type: Mapped[str] = mapped_column(String(8))  # 'user' | 'group'
    subject_id: Mapped[str] = mapped_column(UuidPk)
    level: Mapped[str] = mapped_column(String(8))         # 'viewer' | 'editor' | 'owner'
    # Feingranulare Rechte — nur relevant bei level == 'editor' (owner/admin = alles).
    can_place: Mapped[bool] = mapped_column(Boolean, default=True)
    can_move: Mapped[bool] = mapped_column(Boolean, default=True)
    can_delete: Mapped[bool] = mapped_column(Boolean, default=True)
    can_draw: Mapped[bool] = mapped_column(Boolean, default=True)

    plan: Mapped[Plan] = relationship(back_populates="acl")


class Phase(Base):
    """Abschnitt auf dem Zeitstrahl. phase_id NULL an einem Marker = 'global'."""

    __tablename__ = "phases"

    id: Mapped[str] = mapped_column(UuidPk, primary_key=True, default=uuid_str)
    plan_id: Mapped[str] = mapped_column(ForeignKey("plans.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(128))
    ordering: Mapped[int] = mapped_column(Integer, default=0)
    # Parallele Ebenen: 'player' (Standard) | 'builder' (nur Missionsbau sichtbar).
    plane: Mapped[str] = mapped_column(String(8), default="player")
    parent_id: Mapped[str | None] = mapped_column(ForeignKey("phases.id", ondelete="CASCADE"))
    sub_ordering: Mapped[int] = mapped_column(Integer, default=0)
    start_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # optionaler Start
    end_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))     # optionales Ende
    notes: Mapped[str] = mapped_column(Text, default="")  # Markdown-Notizen zur Phase
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Layer(Base):
    """Sicht-/Bearbeitungs-Ebene innerhalb eines Plans (z. B. je Platoon).

    group_id gesetzt = nur diese Gruppe (plus Plan-owner/admin) sieht/bearbeitet die Ebene.
    """

    __tablename__ = "layers"

    id: Mapped[str] = mapped_column(UuidPk, primary_key=True, default=uuid_str)
    plan_id: Mapped[str] = mapped_column(ForeignKey("plans.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(128))
    color: Mapped[int] = mapped_column(Integer, default=-1)
    ordering: Mapped[int] = mapped_column(Integer, default=0)
    group_id: Mapped[str | None] = mapped_column(ForeignKey("groups.id", ondelete="SET NULL"))
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Marker(Base):
    __tablename__ = "markers"

    id: Mapped[str] = mapped_column(UuidPk, primary_key=True, default=uuid_str)
    plan_id: Mapped[str] = mapped_column(ForeignKey("plans.id", ondelete="CASCADE"), index=True)
    phase_id: Mapped[str | None] = mapped_column(
        ForeignKey("phases.id", ondelete="SET NULL"), index=True
    )  # NULL = global
    layer_id: Mapped[str | None] = mapped_column(
        ForeignKey("layers.id", ondelete="SET NULL"), index=True
    )
    orbat_node_id: Mapped[str | None] = mapped_column(
        ForeignKey("orbat_nodes.id", ondelete="SET NULL"), index=True
    )
    orbat_strength: Mapped[int] = mapped_column(Integer, default=1)  # Einheiten, die dieser Marker abbildet

    sidc: Mapped[str] = mapped_column(String(64))
    world_x: Mapped[float] = mapped_column(Float)
    world_y: Mapped[float] = mapped_column(Float)
    rotation_degrees: Mapped[int] = mapped_column(Integer, default=-1)  # 8-Richtungen-Pfeil, -1 = stationär
    icon_rotation: Mapped[float] = mapped_column(Float, default=0)       # freie Icon-Drehung (Grad)
    scale: Mapped[float] = mapped_column(Float, default=1.0)             # 0.25–3.0, für alle sichtbar
    unit_text: Mapped[str] = mapped_column(String(255), default="")
    ai_text: Mapped[str] = mapped_column(String(255), default="")
    channel: Mapped[str] = mapped_column(String(64), default="")
    locked: Mapped[bool] = mapped_column(Boolean, default=False)
    timestamp_visible: Mapped[bool] = mapped_column(Boolean, default=True)
    # Phase-Line-/Zeichnen-Ketten (ATAKmaps Doku SIDC-Data-Interface.md 1a)
    linked_group_id: Mapped[int] = mapped_column(Integer, default=-1)
    point_index: Mapped[int] = mapped_column(Integer, default=-1)
    line_color: Mapped[int] = mapped_column(Integer, default=-1)
    line_width: Mapped[float] = mapped_column(Float, default=-1)

    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    updated_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)


class Annotation(Base):
    """Frei platzierbares Markdown-Textfeld auf der Karte (wie ein Klebezettel).
    Wird wie Marker per WebSocket synchronisiert."""

    __tablename__ = "annotations"

    id: Mapped[str] = mapped_column(UuidPk, primary_key=True, default=uuid_str)
    plan_id: Mapped[str] = mapped_column(ForeignKey("plans.id", ondelete="CASCADE"), index=True)
    phase_id: Mapped[str | None] = mapped_column(ForeignKey("phases.id", ondelete="SET NULL"), index=True)
    world_x: Mapped[float] = mapped_column(Float)
    world_y: Mapped[float] = mapped_column(Float)
    text: Mapped[str] = mapped_column(Text, default="")
    width: Mapped[float] = mapped_column(Float, default=220)
    height: Mapped[float] = mapped_column(Float, default=0)  # 0 = automatisch
    # Zoom-Skalierung: standardmäßig skaliert die Notiz mit der Karte; scale_fixed
    # friert sie auf Bildschirmgröße ein. ref_zoom = Zoom, bei dem width "natürlich" ist.
    scale_fixed: Mapped[bool] = mapped_column(Boolean, default=False)
    ref_zoom: Mapped[float] = mapped_column(Float, default=0)
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    updated_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)


class Stroke(Base):
    __tablename__ = "strokes"

    id: Mapped[str] = mapped_column(UuidPk, primary_key=True, default=uuid_str)
    plan_id: Mapped[str] = mapped_column(ForeignKey("plans.id", ondelete="CASCADE"), index=True)
    phase_id: Mapped[str | None] = mapped_column(ForeignKey("phases.id", ondelete="SET NULL"), index=True)
    layer_id: Mapped[str | None] = mapped_column(ForeignKey("layers.id", ondelete="SET NULL"), index=True)
    kind: Mapped[str] = mapped_column(String(16), default="freehand")  # freehand | phaseline
    channel: Mapped[str] = mapped_column(String(64), default="")
    points: Mapped[list] = mapped_column(JSON, default=list)           # [[x, y], ...]
    color: Mapped[int] = mapped_column(Integer, default=-1)
    width: Mapped[float] = mapped_column(Float, default=-1)
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class PlanVersion(Base):
    __tablename__ = "plan_versions"

    id: Mapped[str] = mapped_column(UuidPk, primary_key=True, default=uuid_str)
    plan_id: Mapped[str] = mapped_column(ForeignKey("plans.id", ondelete="CASCADE"), index=True)
    label: Mapped[str] = mapped_column(String(128), default="")
    snapshot: Mapped[dict] = mapped_column(JSON)  # {markers: [...], strokes: [...]}
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class PublicShare(Base):
    """Öffentlicher Nur-Lese-Link zu einem Plan (ohne Login)."""

    __tablename__ = "public_shares"

    token: Mapped[str] = mapped_column(String(48), primary_key=True)
    plan_id: Mapped[str] = mapped_column(ForeignKey("plans.id", ondelete="CASCADE"), index=True)
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    label: Mapped[str] = mapped_column(String(128), default="")
    include_builder: Mapped[bool] = mapped_column(Boolean, default=False)  # Missionsbau-Phasen mit freigeben
    # Rechte je Link
    can_point: Mapped[bool] = mapped_column(Boolean, default=True)   # zeigen (Cursor)
    can_edit: Mapped[bool] = mapped_column(Boolean, default=False)   # anlegen/ändern/löschen
    can_move: Mapped[bool] = mapped_column(Boolean, default=False)   # Marker verschieben
    # Eingrenzung: entweder feste Phasen-IDs ODER Zeitfenster (Plan-Zeitstrahl)
    phase_ids: Mapped[list] = mapped_column(JSON, default=list)
    date_from: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    date_to: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)


class Favorite(Base):
    """Persönliche Marker-Favoriten eines Users (Icon-SIDC + Beschriftung + Defaults)."""

    __tablename__ = "favorites"

    id: Mapped[str] = mapped_column(UuidPk, primary_key=True, default=uuid_str)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    label: Mapped[str] = mapped_column(String(128))
    sidc: Mapped[str] = mapped_column(String(64))
    rotation_degrees: Mapped[int] = mapped_column(Integer, default=-1)
    unit_text: Mapped[str] = mapped_column(String(255), default="")
    ai_text: Mapped[str] = mapped_column(String(255), default="")
    channel: Mapped[str] = mapped_column(String(64), default="")
    is_multipoint: Mapped[bool] = mapped_column(Boolean, default=False)
    max_line_points: Mapped[int] = mapped_column(Integer, default=0)
    ordering: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[str] = mapped_column(UuidPk, primary_key=True, default=uuid_str)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)
    user_id: Mapped[str | None] = mapped_column(String(32))
    action: Mapped[str] = mapped_column(String(64))
    target_type: Mapped[str | None] = mapped_column(String(32))
    target_id: Mapped[str | None] = mapped_column(String(64))
    detail: Mapped[dict] = mapped_column(JSON, default=dict)


# ─── ORBAT (globale Kräfteübersicht) ────────────────────────────────────────

class Orbat(Base):
    __tablename__ = "orbats"

    id: Mapped[str] = mapped_column(UuidPk, primary_key=True, default=uuid_str)
    name: Mapped[str] = mapped_column(String(128))
    affiliation: Mapped[str] = mapped_column(String(12), default="friend")  # friend|hostile|neutral|unknown
    notes: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class OrbatNode(Base):
    __tablename__ = "orbat_nodes"

    id: Mapped[str] = mapped_column(UuidPk, primary_key=True, default=uuid_str)
    orbat_id: Mapped[str] = mapped_column(ForeignKey("orbats.id", ondelete="CASCADE"), index=True)
    parent_id: Mapped[str | None] = mapped_column(ForeignKey("orbat_nodes.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(128))
    sidc: Mapped[str] = mapped_column(String(64), default="")
    qty_planned: Mapped[int] = mapped_column(Integer, default=1)
    qty_current: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(12), default="active")  # active|damaged|destroyed
    ordering: Mapped[int] = mapped_column(Integer, default=0)
    notes: Mapped[str] = mapped_column(Text, default="")
    # Freigabe an Spieler (global pro ORBAT)
    rel_visible: Mapped[bool] = mapped_column(Boolean, default=False)
    rel_show_type: Mapped[bool] = mapped_column(Boolean, default=False)
    rel_strength: Mapped[int] = mapped_column(Integer, default=50)  # -1 = verborgen, sonst % von Soll


class OrbatACL(Base):
    __tablename__ = "orbat_acl"
    __table_args__ = (
        UniqueConstraint("orbat_id", "subject_type", "subject_id", name="uq_orbat_acl_subject"),
    )

    id: Mapped[str] = mapped_column(UuidPk, primary_key=True, default=uuid_str)
    orbat_id: Mapped[str] = mapped_column(ForeignKey("orbats.id", ondelete="CASCADE"), index=True)
    subject_type: Mapped[str] = mapped_column(String(8))   # user|group
    subject_id: Mapped[str] = mapped_column(UuidPk)
    level: Mapped[str] = mapped_column(String(8))          # viewer|editor
    can_place: Mapped[bool] = mapped_column(Boolean, default=True)
    can_move: Mapped[bool] = mapped_column(Boolean, default=True)


class PlanOrbat(Base):
    __tablename__ = "plan_orbats"

    plan_id: Mapped[str] = mapped_column(ForeignKey("plans.id", ondelete="CASCADE"), primary_key=True)
    orbat_id: Mapped[str] = mapped_column(ForeignKey("orbats.id", ondelete="CASCADE"), primary_key=True)
    added_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
