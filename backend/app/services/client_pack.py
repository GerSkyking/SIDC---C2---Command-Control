"""Client-Pack: Kartenpaket im Kachelformat der lokalen SkyMap-X-App.

Das Paket ist eine Teilmenge des lokalen ``mapdata/<Karte>/``-Ordners (Pixel-Pyramide
für Leaflet ``CRS.Simple``, *nicht* das Web-Mercator-MBTiles der C2-Pläne). C2 speichert
es unverändert und liefert es 1:1 aus — der lokale Client spiegelt die Ordnerstruktur.

ZIP-Struktur:
    clientpack.json                      Manifest (format, map_name, calibration)
    map_config.json                      {"layers": [...], "default_layer": ...}
    <Layer>/map_config.json              {"qualities": [...], "default_quality": ...}
    <Layer>/<Quality>/map_config.json    Welt-Grenzen, image_width, max_zoom, tile_format …
    <Layer>/<Quality>/tiles/<z>/<x>/<y>.<ext>
    Mask_<Name>/…                        Mask-Layer (Hillshade, Slope, …), gleicher Aufbau; in
                                         map_config.json unter "mask_layers" gelistet
    heightmap_client.json / .bin         (optional)
    peaks.json                           (optional)

Ein Client-Pack enthält bewusst KEINE Plan-Daten; es sind reine Kartendaten.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from ..config import get_settings

_settings = get_settings()

PACK_FORMAT = 1
ALLOWED_EXT = {".json", ".bin", ".png", ".webp", ".jpg", ".jpeg"}
_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
_MAP_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,63}$")
_MAX_FILES = 400_000
MASK_PREFIX = "Mask_"
INFO_FILE = ".info.json"  # Server-Metadaten (Version, Größe); wird nie ausgeliefert


class ClientPackError(ValueError):
    pass


def client_dir(map_id: str) -> Path:
    # Absichtlich AUSSERHALB von maps/<id>/ — ein Re-Import der Mercator-Karte
    # (rmtree) darf das Client-Pack nicht mitlöschen. Karten-IDs enthalten keinen Punkt.
    return _settings.maps_dir / f"{map_id}.client"


def _tmp_dir(map_id: str) -> Path:
    return _settings.maps_dir / f".{map_id}.client.new"


def _bak_dir(map_id: str) -> Path:
    return _settings.maps_dir / f".{map_id}.client.old"


def _is_safe_rel(rel: str) -> bool:
    if not rel or rel.startswith(("/", "\\")) or "\\" in rel or "\x00" in rel:
        return False
    parts = rel.split("/")
    return all(p and not p.startswith(".") for p in parts)


def resolve_file(map_id: str, rel: str) -> Path | None:
    """Sicher aufgelöste Datei im Client-Pack oder None (Traversal, unbekannte Endung, fehlt)."""
    if not _MAP_ID_RE.match(map_id) or not _is_safe_rel(rel) or Path(rel).suffix.lower() not in ALLOWED_EXT:
        return None
    base = client_dir(map_id).resolve()
    target = (base / rel).resolve()
    if base not in target.parents or not target.is_file():
        return None
    return target


def read_info(map_id: str) -> dict | None:
    """Manifest + Server-Metadaten für die Client-Liste, oder None (kein Pack)."""
    base = client_dir(map_id)
    try:
        man = json.loads((base / "clientpack.json").read_text(encoding="utf-8"))
        info = json.loads((base / INFO_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return {
        "map_name": man.get("map_name", map_id),
        "layers": man.get("layers", {}),
        "masks": man.get("masks", {}),
        "calibration": man.get("calibration"),
        "version": info.get("version", ""),
        "size_bytes": info.get("size_bytes", 0),
        "files": info.get("files", 0),
        "uploaded_at": info.get("uploaded_at"),
    }


def delete_pack(map_id: str) -> None:
    shutil.rmtree(client_dir(map_id), ignore_errors=True)


def _load_json(path: Path, what: str) -> dict:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ClientPackError(f"{what} fehlt oder ist kein gültiges JSON") from exc
    if not isinstance(doc, dict):
        raise ClientPackError(f"{what} muss ein JSON-Objekt sein")
    return doc


def _extract_checked(zf: zipfile.ZipFile, dest: Path) -> tuple[int, int]:
    """Entpackt nur erlaubte Dateien (Zip-Slip, Endungs-Whitelist, Größenlimit)."""
    limit = _settings.map_import_max_mb * 1024 * 1024
    total = 0
    count = 0
    dest_r = dest.resolve()
    for m in zf.infolist():
        if m.is_dir():
            continue
        if not _is_safe_rel(m.filename):
            raise ClientPackError(f"Unzulässiger Pfad im Archiv: {m.filename!r}")
        if Path(m.filename).suffix.lower() not in ALLOWED_EXT:
            raise ClientPackError(f"Unzulässige Dateiendung: {m.filename!r}")
        total += m.file_size
        count += 1
        if total > limit or count > _MAX_FILES:
            raise ClientPackError("Client-Pack zu groß")
        target = (dest_r / m.filename).resolve()
        if dest_r not in target.parents:
            raise ClientPackError(f"Zip-Slip abgewehrt: {m.filename!r}")
        target.parent.mkdir(parents=True, exist_ok=True)
        with zf.open(m) as src, target.open("wb") as out:
            shutil.copyfileobj(src, out)
    return total, count


def _validate_layer(root: Path, folder: str, label: str | None = None) -> dict:
    """Prüft <folder>/map_config.json und je Qualität <folder>/<q>/map_config.json."""
    name = label if label is not None else folder
    if not isinstance(name, str) or not _NAME_RE.match(name):
        raise ClientPackError(f"Ungültiger Layer-Name: {name!r}")
    lman = _load_json(root / folder / "map_config.json", f"{folder}/map_config.json")
    quals = lman.get("qualities")
    if not isinstance(quals, list) or not quals:
        raise ClientPackError(f"{folder}/map_config.json: 'qualities' fehlt")
    for q in quals:
        if not isinstance(q, str) or not _NAME_RE.match(q):
            raise ClientPackError(f"Ungültige Qualität: {q!r}")
        if not (root / folder / q / "map_config.json").is_file():
            raise ClientPackError(f"{folder}/{q}/map_config.json fehlt")
    return {"qualities": list(quals), "default_quality": lman.get("default_quality")}


def _validate_tree(root: Path) -> dict:
    """Prüft Manifest + Ordnerstruktur, gibt das bereinigte Manifest zurück."""
    man = _load_json(root / "clientpack.json", "clientpack.json")
    if man.get("format") != PACK_FORMAT:
        raise ClientPackError(f"Unbekanntes Pack-Format (erwartet {PACK_FORMAT})")
    map_name = str(man.get("map_name") or "").strip()
    if not map_name:
        raise ClientPackError("clientpack.json: map_name fehlt")

    top = _load_json(root / "map_config.json", "map_config.json")
    if not isinstance(top.get("layers"), list) or not top["layers"]:
        raise ClientPackError("map_config.json: 'layers' fehlt")

    layers = {name: _validate_layer(root, name) for name in top["layers"]}

    masks: dict[str, dict] = {}
    mask_names = top.get("mask_layers", [])
    if not isinstance(mask_names, list):
        raise ClientPackError("map_config.json: 'mask_layers' muss eine Liste sein")
    for name in mask_names:
        masks[name] = _validate_layer(root, f"{MASK_PREFIX}{name}", label=name)

    calib = man.get("calibration")
    if calib is not None:
        try:
            calib = {k: float(calib[k]) for k in ("offset_x", "offset_z", "scale_x", "scale_z")}
        except (KeyError, TypeError, ValueError) as exc:
            raise ClientPackError("clientpack.json: calibration ungültig") from exc

    return {"format": PACK_FORMAT, "map_name": map_name, "layers": layers, "masks": masks, "calibration": calib}


def install_pack(map_id: str, zip_path: Path) -> dict:
    """Validiert das ZIP und ersetzt das Client-Pack der Karte atomar. Gibt read_info() zurück."""
    tmp, bak, dest = _tmp_dir(map_id), _bak_dir(map_id), client_dir(map_id)
    for d in (tmp, bak):
        shutil.rmtree(d, ignore_errors=True)
    tmp.mkdir(parents=True)
    try:
        try:
            with zipfile.ZipFile(zip_path) as zf:
                size, files = _extract_checked(zf, tmp)
        except zipfile.BadZipFile as exc:
            raise ClientPackError("Keine gültige ZIP-Datei") from exc
        manifest = _validate_tree(tmp)
        # Server-seitig bereinigtes Manifest überschreibt das hochgeladene.
        (tmp / "clientpack.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")

        h = hashlib.sha256()
        with zip_path.open("rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        (tmp / INFO_FILE).write_text(
            json.dumps({
                "version": h.hexdigest()[:16],
                "size_bytes": size,
                "files": files,
                "uploaded_at": datetime.now(timezone.utc).isoformat(),
            }),
            encoding="utf-8",
        )

        if dest.exists():
            dest.rename(bak)
        tmp.rename(dest)
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    shutil.rmtree(bak, ignore_errors=True)
    info = read_info(map_id)
    assert info is not None
    return info
