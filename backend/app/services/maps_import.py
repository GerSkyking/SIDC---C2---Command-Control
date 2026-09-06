"""Karten-Import: Mappack-ZIP von einer URL laden ODER direkt hochgeladen, dann
ins Datenverzeichnis entpacken und aufbereiten.

ZIP-Struktur (ATAKmaps-Mappack, erweitert):
    mappack.json                         (optional Manifest)
    calibration.json                     (optional)
    mbtiles/sat.mbtiles                  (Pflicht)
    mbtiles/terrain.mbtiles              (optional)
    mbtiles/grid.mbtiles                 (optional)
    mbtiles/dlc/<layer>_z<N>.mbtiles     (optional, hochauflösende Zoomstufen)
    topo.geojson                         (optional, Vektor-Overlay Straßen/Gewässer/…)
    mapLocations_locations.json          (optional, benannte Orte)
    mapLocations_translations.json       (optional, Ortsnamen je Sprache)
"""
from __future__ import annotations

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

BASE_TYPE_LABELS = {
    58: "Hafen", 59: "Ortschaft", 63: "Anhöhe", 64: "Feld/Flur",
    65: "Insel", 66: "Teich", 68: "Bucht", 70: "Bergrücken",
}


def map_dir(map_id: str) -> Path:
    return _settings.maps_dir / map_id


def _import_tmp(map_id: str) -> Path:
    return _settings.maps_dir / f".import_{map_id}.zip"


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


def effective_maxzoom(map_id: str, layer: str, base_maxzoom: int) -> int:
    """Höchste Zoomstufe mit lückenlosen DLC-Paketen (ATAKmaps-Logik)."""
    dlc = map_dir(map_id) / "mbtiles" / "dlc"
    z = base_maxzoom
    while (dlc / f"{layer}_z{z + 1}.mbtiles").is_file():
        z += 1
    return z


def download_to_tmp(map_id: str, url: str) -> Path:
    """Streamt die URL auf Platte (kein Voll-Puffer) und gibt den Pfad zurück."""
    tmp = _import_tmp(map_id)
    tmp.parent.mkdir(parents=True, exist_ok=True)
    limit = _settings.map_import_max_mb * 1024 * 1024
    written = 0
    with httpx.stream("GET", url, follow_redirects=True, timeout=None) as r:
        r.raise_for_status()
        with tmp.open("wb") as f:
            for chunk in r.iter_bytes():
                written += len(chunk)
                if written > limit:
                    f.close()
                    tmp.unlink(missing_ok=True)
                    raise ValueError(f"ZIP größer als {_settings.map_import_max_mb} MB")
                f.write(chunk)
    return tmp


def run_import(map_id: str, *, url: str | None = None, zip_path: str | None = None) -> None:
    """Blockierend — vom Router in einem Thread/Task ausgeführt. Genau eins von
    url / zip_path angeben. zip_path (Direkt-Upload) wird nach dem Import gelöscht."""
    src: Path | None = None
    with SessionLocal() as db:
        m = db.get(Map, map_id)
        if m is None:
            return
        try:
            src = Path(zip_path) if zip_path else download_to_tmp(map_id, url or "")
            if not src.is_file():
                raise ValueError("Upload-Datei fehlt")

            dest = map_dir(map_id)
            if dest.exists():
                shutil.rmtree(dest)
            dest.mkdir(parents=True)

            with zipfile.ZipFile(src) as zf:
                _safe_extract(zf, dest)

            sat = dest / "mbtiles" / "sat.mbtiles"
            if not sat.is_file():
                raise ValueError("mbtiles/sat.mbtiles fehlt im Archiv")

            meta = _read_mbtiles_meta(sat)
            meta["layers"] = [
                ly for ly in ("sat", "terrain", "grid") if (dest / "mbtiles" / f"{ly}.mbtiles").is_file()
            ]
            meta["sat_maxzoom_effective"] = effective_maxzoom(
                map_id, "sat", int(meta.get("maxzoom", 18))
            )
            meta["dlc"] = _dlc_inventory(dest)

            calib = dest / "calibration.json"
            if calib.is_file():
                meta["calibration"] = json.loads(calib.read_text(encoding="utf-8"))

            pack = dest / "mappack.json"
            if pack.is_file():
                try:
                    meta["mappack"] = json.loads(pack.read_text(encoding="utf-8"))
                except ValueError:
                    pass

            meta["has_topo"] = _validate_topo(dest)
            loc = _build_locations(dest)
            meta["has_locations"] = loc is not None
            if loc is not None:
                meta["location_langs"] = loc["langs"]
                meta["location_groups"] = [
                    {"key": g["key"], "label": g["label"], "count": len(g["items"])}
                    for g in loc["groups"]
                ]

            m.status = "ready"
            m.error = None
            m.meta = meta
            m.imported_at = now()
            db.commit()
            log.info("Karte '%s' importiert (Layer %s, DLC %s)", map_id, meta["layers"], meta["dlc"])
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            m = db.get(Map, map_id)
            if m is not None:
                m.status = "error"
                m.error = str(exc)[:2000]
                db.commit()
            log.exception("Karten-Import '%s' fehlgeschlagen", map_id)
        finally:
            if zip_path and src is not None:
                src.unlink(missing_ok=True)
            _import_tmp(map_id).unlink(missing_ok=True)


def _dlc_inventory(dest: Path) -> dict[str, list[int]]:
    out: dict[str, list[int]] = {}
    dlc = dest / "mbtiles" / "dlc"
    if not dlc.is_dir():
        return out
    for f in dlc.glob("*_z*.mbtiles"):
        try:
            layer, z = f.stem.rsplit("_z", 1)
            out.setdefault(layer, []).append(int(z))
        except ValueError:
            continue
    for v in out.values():
        v.sort()
    return out


def _validate_topo(dest: Path) -> bool:
    p = dest / "topo.geojson"
    if not p.is_file():
        return False
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
        return doc.get("type") == "FeatureCollection"
    except ValueError:
        p.unlink(missing_ok=True)
        return False


def _build_locations(dest: Path) -> dict | None:
    """mapLocations_locations.json (+ _translations.json) → locations.json,
    nach baseType gruppiert, Namen je Sprache aufgelöst."""
    src = dest / "mapLocations_locations.json"
    if not src.is_file():
        return None
    try:
        raw = json.loads(src.read_text(encoding="utf-8"))
    except ValueError:
        return None
    trans: dict = {}
    tp = dest / "mapLocations_translations.json"
    if tp.is_file():
        try:
            trans = json.loads(tp.read_text(encoding="utf-8"))
        except ValueError:
            trans = {}

    langs: set[str] = set()
    for m in trans.values():
        langs.update(m.keys())
    langs_sorted = sorted(langs) or ["en_us", "de_de"]

    groups: dict[int, dict] = {}
    for e in raw:
        if not (e.get("nameLocalized") or e.get("commentText")):
            continue
        gc = e.get("gameCoords") or e.get("position", [0, 0, 0])[:2]
        bt = e.get("baseType", -1)
        key = e.get("name") or ""
        names = {lg: (trans.get(key, {}) or {}).get(lg) or e.get("nameLocalized") or key for lg in langs_sorted}
        item = {
            "x": gc[0],
            "y": gc[1],
            "names": names,
            "color": e.get("commentColor", [1, 1, 1, 1]),
            "bold": bool(e.get("commentBold")),
            "italic": bool(e.get("commentItalic")),
            "size": e.get("commentSizeCoef", 0.75),
        }
        groups.setdefault(bt, {"key": str(bt), "label": BASE_TYPE_LABELS.get(bt, f"Typ {bt}"), "items": []})
        groups[bt]["items"].append(item)

    if not groups:
        return None
    result = {"langs": langs_sorted, "groups": list(groups.values())}
    (dest / "locations.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    return result


def _safe_extract(zf: zipfile.ZipFile, dest: Path) -> None:
    dest = dest.resolve()
    for member in zf.infolist():
        target = (dest / member.filename).resolve()
        if not str(target).startswith(str(dest)):
            raise ValueError(f"Zip-Slip abgewehrt: {member.filename}")
    zf.extractall(dest)
