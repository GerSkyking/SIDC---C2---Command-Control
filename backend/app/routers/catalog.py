"""SIDC-Katalog: die JSON-Dateien aus dem ingame-`LocalMapData`-Ordner, vom Admin
hochgeladen und serverseitig unter /data/catalog/ abgelegt. Format 1:1 wie ingame.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import JSONResponse

from .. import audit
from ..config import get_settings
from ..deps import AdminUser, CurrentUser, DbDep

router = APIRouter(prefix="/api", tags=["catalog"])
_settings = get_settings()

# Erlaubte Dateinamen = die vom Mod exportierten Kataloge (SIDC_MarkerExporter etc.)
CATALOGS = {
    "all-markers": "SIDC_AllMarkersCatalog.json",
    "quick-menu": "SIDC_QuickMarkerMenuCatalog.json",
    "phaseline-style": "SIDC_PhaseLineStyleCatalog.json",
    "channels": "SIDC_ChannelSettings.json",
    "modifiers": "SIDC_ModifierCatalog.json",
    "translations": "SIDC_Translations.json",
}
_MAX_BYTES = 8 * 1024 * 1024


def _xlsx_to_translations(raw: bytes) -> dict:
    """Spiel-Lokalisierungs-Export (.xlsx) → { names: {Id: Name}, desc: {Id: Beschreibung} }.
    Sprache: Deutsch bevorzugt, sonst Englisch (bearbeitete Spalte vor Rohspalte).
    Ids mit Suffix ``_Description`` liefern den Hover-Zusatztext."""
    import io

    import openpyxl

    # read_only=False: manche Exporte setzen eine falsche <dimension ref="A1"/>,
    # bei der read_only nach der ersten Zeile abbräche.
    wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=False, data_only=True)
    it = None
    header: list[str] = []
    for ws in wb.worksheets:  # das Blatt mit einer "Id"-Spalte nehmen
        rows = ws.iter_rows(values_only=True)
        head = [str(c or "") for c in next(rows, [])]
        if "Id" in head:
            it, header = rows, head
            break
    if it is None:
        wb.close()
        raise ValueError("Keine 'Id'-Spalte gefunden")

    def idx(col: str) -> int:
        return header.index(col) if col in header else -1

    ci_id, ci_de, ci_en_e, ci_en = idx("Id"), idx("Target_de_de"), idx("Target_en_us_edited"), idx("Target_en_us")
    names: dict[str, str] = {}
    desc: dict[str, str] = {}
    for row in it:
        if ci_id < 0 or ci_id >= len(row) or not row[ci_id]:
            continue
        rid = str(row[ci_id]).strip().lstrip("#")
        val = ""
        for ci in (ci_de, ci_en_e, ci_en):
            if 0 <= ci < len(row) and row[ci]:
                val = str(row[ci]).strip()
                break
        if not val:
            continue
        if rid.endswith("_Description"):
            desc[rid[:-12]] = val
        else:
            names[rid] = val
    wb.close()
    return {"names": names, "desc": desc}


def _dir():
    # unter dem persistenten uploads-Volume — NICHT /data/catalog (nur uploads+maps sind Volumes)
    d = _settings.uploads_dir / "catalog"
    d.mkdir(parents=True, exist_ok=True)
    return d


@router.get("/catalog")
def catalog_status(user: CurrentUser) -> dict:
    d = _dir()
    return {key: (d / fn).is_file() for key, fn in CATALOGS.items()}


@router.get("/catalog/{name}")
def get_catalog(name: str, user: CurrentUser) -> JSONResponse:
    if name not in CATALOGS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unbekannter Katalog")
    path = _dir() / CATALOGS[name]
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Katalog nicht hochgeladen")
    return JSONResponse(json.loads(path.read_text(encoding="utf-8")))


@router.post("/admin/catalog/{name}")
async def upload_catalog(name: str, request: Request, admin: AdminUser, db: DbDep) -> dict:
    """Roher JSON-Body (kein Multipart) — schlanker durch den Reverse Proxy."""
    if name not in CATALOGS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unbekannter Katalog")
    raw = await request.body()
    if len(raw) > _MAX_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Datei zu groß")
    if name == "translations" and raw[:2] == b"PK":  # .xlsx → JSON konvertieren
        try:
            data = _xlsx_to_translations(raw)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"XLSX nicht lesbar: {exc}") from exc
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
    else:
        try:
            json.loads(raw)  # nur validieren, unverändert speichern
        except ValueError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Kein gültiges JSON: {exc}") from exc
    (_dir() / CATALOGS[name]).write_bytes(raw)
    audit.record(db, "catalog.upload", user_id=admin.id, target_type="catalog", target_id=name,
                 request=request, bytes=len(raw))
    return {"ok": True, "name": name, "bytes": len(raw)}


@router.delete("/admin/catalog/{name}")
def delete_catalog(name: str, request: Request, admin: AdminUser, db: DbDep) -> dict:
    if name not in CATALOGS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unbekannter Katalog")
    (_dir() / CATALOGS[name]).unlink(missing_ok=True)
    audit.record(db, "catalog.delete", user_id=admin.id, target_type="catalog", target_id=name,
                 request=request)
    return {"ok": True}
