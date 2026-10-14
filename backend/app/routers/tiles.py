"""MBTiles-Tileserver + MapLibre-style.json pro Karte.

Portiert aus ATAKmaps (server/app.py) — ohne DLC-/Live-Logik. Die MBTiles-`bounds`
sind bereits im Koordinatenraum, den die Web-Karte nutzt; Marker werden im selben
Raum gespeichert (Klick-`lngLat`).
"""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import JSONResponse

from ..deps import DbDep, MapsReader
from ..models import Map
from ..services.maps_import import effective_maxzoom, map_dir

router = APIRouter(prefix="/api/maps/{map_id}", tags=["tiles"])

_LAYERS = ("sat", "terrain", "grid")
_conn_cache: dict[str, sqlite3.Connection] = {}


def _conn(map_id: str, layer: str) -> sqlite3.Connection | None:
    key = f"{map_id}:{layer}"
    if key not in _conn_cache:
        path = map_dir(map_id) / "mbtiles" / f"{layer}.mbtiles"
        if not path.is_file():
            return None
        _conn_cache[key] = sqlite3.connect(f"file:{path}?mode=ro", uri=True, check_same_thread=False)
    return _conn_cache[key]


def _meta(map_id: str, layer: str) -> dict:
    con = _conn(map_id, layer)
    if con is None:
        return {}
    return dict(con.execute("SELECT name, value FROM metadata").fetchall())


def _dlc_conn(map_id: str, layer: str, zoom: int) -> sqlite3.Connection | None:
    key = f"{map_id}:{layer}:dlc{zoom}"
    if key not in _conn_cache:
        path = map_dir(map_id) / "mbtiles" / "dlc" / f"{layer}_z{zoom}.mbtiles"
        if not path.is_file():
            return None
        _conn_cache[key] = sqlite3.connect(f"file:{path}?mode=ro", uri=True, check_same_thread=False)
    return _conn_cache[key]


def _tile(map_id: str, layer: str, z: int, x: int, y: int, base_maxzoom: int) -> bytes | None:
    con = _conn(map_id, layer) if z <= base_maxzoom else _dlc_conn(map_id, layer, z)
    if con is None:
        return None
    tms_y = (2 ** z - 1) - y  # MBTiles speichert TMS-Reihenfolge
    row = con.execute(
        "SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
        (z, x, tms_y),
    ).fetchone()
    return row[0] if row else None


@router.get("/tiles/{layer}/{z}/{x}/{y}.png")
def tile(map_id: str, layer: str, z: int, x: int, y: int, auth: MapsReader) -> Response:
    data = read_tile(map_id, layer, z, x, y)
    if data is None:
        raise HTTPException(404)
    return Response(data, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


@router.get("/topo.geojson")
def topo(map_id: str, auth: MapsReader) -> Response:
    p = map_dir(map_id) / "topo.geojson"
    if not p.is_file():
        raise HTTPException(404, "Kein Topo-Layer")
    return Response(p.read_bytes(), media_type="application/geo+json",
                    headers={"Cache-Control": "public, max-age=86400"})


@router.get("/locations.json")
def locations(map_id: str, auth: MapsReader) -> Response:
    p = map_dir(map_id) / "locations.json"
    if not p.is_file():
        raise HTTPException(404, "Keine Map-Locations")
    return Response(p.read_bytes(), media_type="application/json",
                    headers={"Cache-Control": "public, max-age=86400"})


@router.get("/contours.geojson")
def contours(map_id: str, auth: MapsReader) -> Response:
    p = map_dir(map_id) / "contours.geojson"
    if not p.is_file():
        raise HTTPException(404, "Keine Hoehenlinien")
    return Response(p.read_bytes(), media_type="application/geo+json",
                    headers={"Cache-Control": "public, max-age=86400"})


@router.get("/peaks.geojson")
def peaks(map_id: str, auth: MapsReader) -> Response:
    p = map_dir(map_id) / "peaks.geojson"
    if not p.is_file():
        raise HTTPException(404, "Keine Hoehenpunkte")
    return Response(p.read_bytes(), media_type="application/geo+json",
                    headers={"Cache-Control": "public, max-age=86400"})


# Enfusion-TopoExport-Layer (aus dem ATAKmaps-Mappack, pipeline/enfusion_layers.py)
ENFUSION_LAYERS = ("buildings", "roads", "water", "powerlines", "trees")


@router.get("/{layer}.geojson")
def enfusion_layer(map_id: str, layer: str, auth: MapsReader) -> Response:
    if layer not in ENFUSION_LAYERS:
        raise HTTPException(404)
    p = map_dir(map_id) / f"{layer}.geojson"
    if not p.is_file():
        raise HTTPException(404, "Layer nicht vorhanden")
    return Response(p.read_bytes(), media_type="application/geo+json",
                    headers={"Cache-Control": "public, max-age=86400"})


def build_style(map_id: str, tile_base: str) -> dict:
    """MapLibre-style.json für eine Karte. `tile_base` = URL-Präfix der Tile-Routen
    (authentifiziert: /api/maps/<id>/tiles, öffentlich: /public/plans/<token>/tiles)."""
    sat = _meta(map_id, "sat")
    terr = _meta(map_id, "terrain")
    grid = _meta(map_id, "grid")

    bounds_str = sat.get("bounds") or grid.get("bounds") or "0,0,1,1"
    bounds = [float(v) for v in bounds_str.split(",")]
    cx, cy = (bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2
    min_z = int(sat.get("minzoom", 8))
    max_z = effective_maxzoom(map_id, "sat", int(sat.get("maxzoom", 18)))
    base = tile_base

    doc: dict = {
        "version": 8,
        "name": f"GameMap — {map_id}",
        "center": [cx, cy],
        "zoom": min_z + 2,
        "sources": {},
        "layers": [{"id": "bg", "type": "background", "paint": {"background-color": "#0b0d10"}}],
    }

    if _conn(map_id, "sat") is not None:
        doc["sources"]["sat"] = {
            "type": "raster", "tiles": [f"{base}/sat/{{z}}/{{x}}/{{y}}.png"],
            "tileSize": 256, "minzoom": min_z, "maxzoom": max_z, "bounds": bounds,
        }
        doc["layers"].append({"id": "sat", "type": "raster", "source": "sat"})
        # Vereinfachte Karte als eigene, standardmäßig ausgeblendete Ebene
        doc["sources"][SIMPLE_LAYER] = {
            "type": "raster", "tiles": [f"{base}/{SIMPLE_LAYER}/{{z}}/{{x}}/{{y}}.png"],
            "tileSize": 256, "minzoom": min_z, "maxzoom": max_z, "bounds": bounds,
        }
        doc["layers"].append({
            "id": SIMPLE_LAYER, "type": "raster", "source": SIMPLE_LAYER,
            "layout": {"visibility": "none"},
        })

    if _conn(map_id, "grid") is not None:
        g_bounds = [float(v) for v in (grid.get("bounds") or bounds_str).split(",")]
        doc["sources"]["grid"] = {
            "type": "raster", "tiles": [f"{base}/grid/{{z}}/{{x}}/{{y}}.png"],
            "tileSize": 256, "minzoom": int(grid.get("minzoom", min_z)),
            "maxzoom": int(grid.get("maxzoom", max_z)), "bounds": g_bounds,
        }
        doc["layers"].append({"id": "grid", "type": "raster", "source": "grid"})

    if _conn(map_id, "terrain") is not None:
        doc["sources"]["terrain-dem"] = {
            "type": "raster-dem", "tiles": [f"{base}/terrain/{{z}}/{{x}}/{{y}}.png"],
            "tileSize": 256, "encoding": "terrarium",
            "minzoom": int(terr.get("minzoom", min_z)), "maxzoom": int(terr.get("maxzoom", max_z)),
        }
    return doc


# Vereinfachte Satellitenkarte: aus dem Sat-Tile abgeleitet (weichgezeichnet, auf wenige
# flache Kartenfarben reduziert). Wird bei Bedarf berechnet und im Speicher gepuffert.
SIMPLE_LAYER = "satsimple"
_SIMPLE_PALETTE: tuple[tuple[int, int, int], ...] = (
    (126, 168, 92),    # Wiese
    (88, 138, 72),     # Busch/Feld dunkel
    (52, 100, 56),     # Wald
    (205, 192, 140),   # Acker/Sand
    (166, 150, 112),   # Erde/Fels hell
    (150, 150, 146),   # Fels/Beton
    (226, 226, 220),   # Hell/Asphalt
    (70, 120, 176),    # Wasser
)
_simple_cache: dict[tuple[str, int, int, int], bytes | None] = {}


def _simple_tile(map_id: str, z: int, x: int, y: int) -> bytes | None:
    key = (map_id, z, x, y)
    if key in _simple_cache:
        return _simple_cache[key]
    try:
        from PIL import Image, ImageFilter
    except ImportError:  # Pillow nicht installiert -> Ebene steht nicht zur Verfügung
        return None
    import io

    src = read_tile(map_id, "sat", z, x, y)
    out: bytes | None = None
    if src:
        img = Image.open(io.BytesIO(src)).convert("RGB")
        img = img.filter(ImageFilter.GaussianBlur(radius=max(2.0, img.width / 48)))
        pal = Image.new("P", (1, 1))
        flat = [c for rgb in _SIMPLE_PALETTE for c in rgb]
        pal.putpalette(flat + [0] * (768 - len(flat)))
        img = img.quantize(palette=pal, dither=Image.Dither.NONE).convert("RGB")
        img = img.filter(ImageFilter.ModeFilter(5))  # Einzelpixel-Rauschen glätten
        buf = io.BytesIO()
        img.save(buf, "PNG", optimize=True)
        out = buf.getvalue()
    if len(_simple_cache) > 4000:
        _simple_cache.clear()
    _simple_cache[key] = out
    return out


def read_tile(map_id: str, layer: str, z: int, x: int, y: int) -> bytes | None:
    if layer == SIMPLE_LAYER:
        return _simple_tile(map_id, z, x, y)
    if layer not in _LAYERS:
        return None
    base_maxzoom = int(_meta(map_id, layer).get("maxzoom", 18))
    return _tile(map_id, layer, z, x, y, base_maxzoom)


@router.get("/style.json")
def style_json(map_id: str, auth: MapsReader, db: DbDep) -> JSONResponse:
    if db.get(Map, map_id) is None:
        raise HTTPException(404, "Karte nicht gefunden")
    return JSONResponse(
        build_style(map_id, f"/api/maps/{map_id}/tiles"), headers={"Cache-Control": "no-cache"}
    )
