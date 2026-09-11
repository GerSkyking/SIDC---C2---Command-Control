"""image_placements – ein Bild kann jetzt beliebig oft (auch in mehreren
Phasen) auf der Karte platziert werden, statt nur einmal (on_map/world_x/...).

Bestehende platzierte Bilder (on_map=true) werden in je eine Platzierungszeile
übernommen, danach werden die alten Platzierungsspalten von plan_images entfernt.

Revision ID: 0019_image_placements
Revises: 0018_plan_image_note
Create Date: 2026-09-12
"""
import uuid

import sqlalchemy as sa
from alembic import op

revision = "0019_image_placements"
down_revision = "0018_plan_image_note"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if not insp.has_table("plan_images"):
        return

    if not insp.has_table("image_placements"):
        op.create_table(
            "image_placements",
            sa.Column("id", sa.String(length=32), primary_key=True),
            sa.Column("image_id", sa.String(length=32), sa.ForeignKey("plan_images.id", ondelete="CASCADE"), index=True),
            sa.Column("plan_id", sa.String(length=32), sa.ForeignKey("plans.id", ondelete="CASCADE"), index=True),
            sa.Column("phase_id", sa.String(length=32), sa.ForeignKey("phases.id", ondelete="SET NULL"), index=True),
            sa.Column("world_x", sa.Float(), nullable=False, server_default="0"),
            sa.Column("world_y", sa.Float(), nullable=False, server_default="0"),
            sa.Column("map_width", sa.Float(), nullable=False, server_default="240"),
            sa.Column("scale_fixed", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("ref_zoom", sa.Float(), nullable=False, server_default="0"),
            sa.Column("created_by", sa.String(length=32), sa.ForeignKey("users.id", ondelete="SET NULL")),
            sa.Column("updated_by", sa.String(length=32), sa.ForeignKey("users.id", ondelete="SET NULL")),
            sa.Column("created_at", sa.DateTime(timezone=True)),
            sa.Column("updated_at", sa.DateTime(timezone=True)),
        )

    cols = {c["name"] for c in insp.get_columns("plan_images")}
    if "on_map" in cols:
        # Bestehende Platzierungen (on_map=true) 1:1 in image_placements übernehmen.
        rows = bind.execute(
            sa.text(
                "SELECT id, plan_id, phase_id, world_x, world_y, map_width, "
                "scale_fixed, ref_zoom, created_by, updated_by, created_at, updated_at "
                "FROM plan_images WHERE on_map = :t"
            ),
            {"t": True},
        ).fetchall()
        # created_at/updated_at bewusst ohne Typ: über sa.text() gelesene Werte
        # kommen auf SQLite als roher String zurück (kein DateTime-Objekt) — mit
        # explizitem sa.DateTime-Typ würde der Insert daran scheitern. Ohne Typ
        # reicht SQLAlchemy den Wert unverändert an den DBAPI-Treiber durch.
        placements_tbl = sa.table(
            "image_placements",
            sa.column("id", sa.String), sa.column("image_id", sa.String),
            sa.column("plan_id", sa.String), sa.column("phase_id", sa.String),
            sa.column("world_x", sa.Float), sa.column("world_y", sa.Float),
            sa.column("map_width", sa.Float), sa.column("scale_fixed", sa.Boolean),
            sa.column("ref_zoom", sa.Float), sa.column("created_by", sa.String),
            sa.column("updated_by", sa.String), sa.column("created_at"),
            sa.column("updated_at"),
        )
        for r in rows:
            op.execute(
                placements_tbl.insert().values(
                    id=uuid.uuid4().hex, image_id=r.id, plan_id=r.plan_id, phase_id=r.phase_id,
                    world_x=r.world_x, world_y=r.world_y, map_width=r.map_width,
                    scale_fixed=r.scale_fixed, ref_zoom=r.ref_zoom,
                    created_by=r.created_by, updated_by=r.updated_by,
                    created_at=r.created_at, updated_at=r.updated_at,
                )
            )
        with op.batch_alter_table("plan_images") as batch_op:
            for c in ("on_map", "world_x", "world_y", "map_width", "scale_fixed", "ref_zoom"):
                batch_op.drop_column(c)


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if insp.has_table("plan_images") and "on_map" not in {c["name"] for c in insp.get_columns("plan_images")}:
        with op.batch_alter_table("plan_images") as batch_op:
            batch_op.add_column(sa.Column("on_map", sa.Boolean(), nullable=False, server_default=sa.false()))
            batch_op.add_column(sa.Column("world_x", sa.Float(), nullable=False, server_default="0"))
            batch_op.add_column(sa.Column("world_y", sa.Float(), nullable=False, server_default="0"))
            batch_op.add_column(sa.Column("map_width", sa.Float(), nullable=False, server_default="240"))
            batch_op.add_column(sa.Column("scale_fixed", sa.Boolean(), nullable=False, server_default=sa.false()))
            batch_op.add_column(sa.Column("ref_zoom", sa.Float(), nullable=False, server_default="0"))
        if insp.has_table("image_placements"):
            # Je Bild die zuletzt aktualisierte Platzierung zurückschreiben (portabel,
            # ohne DB-spezifisches DISTINCT ON).
            rows = bind.execute(
                sa.text(
                    "SELECT image_id, world_x, world_y, map_width, scale_fixed, ref_zoom, updated_at "
                    "FROM image_placements ORDER BY updated_at"
                )
            ).fetchall()
            latest: dict[str, object] = {}
            for r in rows:
                latest[r.image_id] = r
            for image_id, r in latest.items():
                bind.execute(
                    sa.text(
                        "UPDATE plan_images SET on_map = :t, world_x = :wx, world_y = :wy, "
                        "map_width = :mw, scale_fixed = :sf, ref_zoom = :rz WHERE id = :id"
                    ),
                    {
                        "t": True, "wx": r.world_x, "wy": r.world_y, "mw": r.map_width,
                        "sf": r.scale_fixed, "rz": r.ref_zoom, "id": image_id,
                    },
                )
    op.drop_table("image_placements")
