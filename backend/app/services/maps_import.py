"""Karten-Import: exportierte ZIP von einer URL laden und ins Datenverzeichnis entpacken.

Erwartete ZIP-Struktur (wie ATAKmaps-Kartenpaket):
    mbtiles/sat.mbtiles           (Pflicht)
    mbtiles/terrain.mbtiles       (optional)
    mbtiles/grid.mbtiles          (optional)
    calibration.json              (optional)
    SIDC_*.json                   (optional Katalog-Dateien)
"""
from __future__ import annotations

import io
import json
import logging
import shutil
import sqlite3
import zipfile
from pathlib import Path

import httpx

from ..config import get_settings
from ..db import SessionLocal
from ..models import Map, now

log = logging.getLogger("sidc.maps")
_settings = get_settings()


def map_dir(map_id: str) -> Path:
    return _settings.maps_dir / map_id


def _read_mbtiles_meta(path: Path) -> dict:
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        rows = dict(con.execute("SELECT name, value FROM metadata").fetchall())
        con.close()
    except sqlite3.Error:
        return {}
    out: dict = {}
    if "bounds" in rows:
        out["bounds"] = [float(v) for v in rows["bounds"].split(",")]
    for k in ("minzoom", "maxzoom"):
        if k in rows:
            out[k] = int(rows[k])
    return out


def run_import(map_id: str, url: str) -> None:
    """Blockierend — vom Router in einem Thread/Task ausgeführt."""
    with SessionLocal() as db:
        m = db.get(Map, map_id)
        if m is None:
            return
        try:
            limit = _settings.map_import_max_mb * 1024 * 1024
            buf = io.BytesIO()
            with httpx.stream("GET", url, follow_redirects=True, timeout=None) as r:
                r.raise_for_status()
                for chunk in r.iter_bytes():
                    buf.write(chunk)
                    if buf.tell() > limit:
                        raise ValueError(f"ZIP größer als {_settings.map_import_max_mb} MB")

            dest = map_dir(map_id)
            if dest.exists():
                shutil.rmtree(dest)
            dest.mkdir(parents=True)

            with zipfile.ZipFile(buf) as zf:
                _safe_extract(zf, dest)

            sat = dest / "mbtiles" / "sat.mbtiles"
            if not sat.is_file():
                raise ValueError("mbtiles/sat.mbtiles fehlt im Archiv")

            meta = _read_mbtiles_meta(sat)
            calib_path = dest / "calibration.json"
            if calib_path.is_file():
                meta["calibration"] = json.loads(calib_path.read_text(encoding="utf-8"))

            m.status = "ready"
            m.error = None
            m.meta = meta
            m.imported_at = now()
            db.commit()
            log.info("Karte '%s' importiert", map_id)
        except Exception as exc:  # noqa: BLE001 — Fehler landet in der DB
            db.rollback()
            m = db.get(Map, map_id)
            if m is not None:
                m.status = "error"
                m.error = str(exc)[:2000]
                db.commit()
            log.exception("Karten-Import '%s' fehlgeschlagen", map_id)


def _safe_extract(zf: zipfile.ZipFile, dest: Path) -> None:
    dest = dest.resolve()
    for member in zf.infolist():
        target = (dest / member.filename).resolve()
        if not str(target).startswith(str(dest)):
            raise ValueError(f"Zip-Slip abgewehrt: {member.filename}")
    zf.extractall(dest)
