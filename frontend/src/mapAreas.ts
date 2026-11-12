// Wiederverwendbare Flächen-Hilfen für MapLibre (öffentliche Ansicht, später Plan-Editor):
// Schraffur-Muster erzeugen/registrieren, Flächen-Layer (Füllung 25 %, Außenlinie 50 %) anlegen,
// GeoJSON aus Punktlisten bauen, Schwerpunkt und Flächeninhalt (m² auf der Spielkarte) berechnen.
// Punkte sind immer [lng, lat] wie bei Strokes und Annotation-Bereichen.
import type { GeoJSONSource, Map as MlMap } from "maplibre-gl";
import { lngLatToWorld, type Calibration } from "./sidc/sidc";

export type LngLat = [number, number];

/** Farben der Annotations-Bereiche (wie im Plan-Editor): pink = Missionsbau-Layer-Notiz, gelb sonst. */
export const AREA_COLORS = { mb: "#ff2d95", all: "#ffc21a" } as const;
/** Deckkraft der schraffierten Füllung bzw. der Außenlinie. */
export const AREA_FILL_OPACITY = 0.25;
export const AREA_LINE_OPACITY = 0.5;

/** Diagonale Schraffur (16×16 px, nahtlos kachelbar) in der gegebenen Farbe. */
export function hatchImage(color: string, n = 16, lineWidth = 2.2): ImageData {
  const cv = document.createElement("canvas");
  cv.width = cv.height = n;
  const g = cv.getContext("2d")!;
  g.strokeStyle = color;
  g.lineWidth = lineWidth;
  g.beginPath();
  for (const o of [-n, 0, n]) {
    g.moveTo(o, n);
    g.lineTo(o + n, 0);
  }
  g.stroke();
  return g.getImageData(0, 0, n, n);
}

/** Bild-ID des Schraffur-Musters einer Farbe ("#rrggbb" → "hatch-rrggbb"). */
export function hatchId(color: string): string {
  return "hatch-" + color.replace(/[^0-9a-zA-Z]/g, "").toLowerCase();
}

/** Schraffur-Muster für eine Farbe registrieren (idempotent; auch nach Stilwechsel erneut aufrufen). */
export function ensureHatch(map: MlMap, color: string): string {
  const id = hatchId(color);
  if (!map.hasImage(id)) map.addImage(id, hatchImage(color));
  return id;
}

/** Geschlossener Ring (erster Punkt am Ende wiederholt), wie GeoJSON-Polygone ihn verlangen. */
export function ringOf(pts: LngLat[]): LngLat[] {
  if (!pts.length) return [];
  const a = pts[0];
  const b = pts[pts.length - 1];
  return a[0] === b[0] && a[1] === b[1] ? pts.slice() : [...pts, a];
}

/** Doppelten Schlusspunkt entfernen (falls die Liste bereits als Ring gespeichert ist). */
function openRing(pts: LngLat[]): LngLat[] {
  if (pts.length < 2) return pts;
  const a = pts[0];
  const b = pts[pts.length - 1];
  return a[0] === b[0] && a[1] === b[1] ? pts.slice(0, -1) : pts;
}

/**
 * Features einer Fläche bzw. Linie: geschlossen (≥ 3 Punkte) → Polygon + Außenlinie, sonst nur Linie.
 * ``props`` landet an allen Features; der Füll-Layer filtert auf Polygone, der Linien-Layer auf Linien.
 */
export function areaFeatures(pts: LngLat[], closed: boolean, props: Record<string, unknown>): GeoJSON.Feature[] {
  const p = openRing(pts);
  if (p.length < 2) return [];
  if (closed && p.length >= 3) {
    const ring = ringOf(p);
    return [
      { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: props },
      { type: "Feature", geometry: { type: "LineString", coordinates: ring }, properties: props },
    ];
  }
  return [{ type: "Feature", geometry: { type: "LineString", coordinates: p }, properties: props }];
}

export interface AreaLayerOpts {
  /** Layer-ID, vor der die Flächen-Layer eingefügt werden (z. B. Marker-Layer). */
  before?: string;
  /** Linienbreite (Zahl oder Ausdruck), Standard 2.5 bzw. Feature-Property "width". */
  lineWidth?: number | unknown[];
}

/**
 * Quelle ``id`` + Layer ``<id>-fill`` (schraffiert, ``fill-pattern`` aus Property "pat") und
 * ``<id>-line`` (Farbe aus Property "color") anlegen, falls noch nicht vorhanden.
 * Feature-Properties: ``color`` ("#rrggbb"), ``pat`` (Bild-ID aus ``ensureHatch``), optional ``op``
 * (Deckkraft-Faktor 0..1), ``fill`` (false = ungefüllt), ``width``.
 */
export function ensureAreaLayers(map: MlMap, id: string, opts: AreaLayerOpts = {}): void {
  if (map.getSource(id)) return;
  const before = opts.before && map.getLayer(opts.before) ? opts.before : undefined;
  map.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer(
    {
      id: `${id}-fill`,
      type: "fill",
      source: id,
      filter: ["all", ["==", ["geometry-type"], "Polygon"], ["!=", ["get", "fill"], false]],
      paint: {
        "fill-pattern": ["get", "pat"],
        "fill-opacity": ["*", AREA_FILL_OPACITY, ["coalesce", ["get", "op"], 1]],
      },
    },
    before,
  );
  map.addLayer(
    {
      id: `${id}-line`,
      type: "line",
      source: id,
      filter: ["==", ["geometry-type"], "LineString"],
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": (opts.lineWidth ?? ["coalesce", ["get", "width"], 2.5]) as never,
        "line-opacity": ["*", AREA_LINE_OPACITY, ["coalesce", ["get", "op"], 1]],
      },
    },
    before,
  );
}

/** Daten einer mit ``ensureAreaLayers`` angelegten Quelle setzen; registriert benötigte Schraffuren. */
export function setAreaData(map: MlMap, id: string, features: GeoJSON.Feature[]): void {
  for (const f of features) {
    const c = f.properties?.color;
    if (typeof c === "string" && f.geometry.type === "Polygon") ensureHatch(map, c);
  }
  (map.getSource(id) as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features });
}

// ── Geometrie ────────────────────────────────────────────────────────────

/** Ohne Kalibrierung: lokale Näherung (Äquirektangular) um den ersten Punkt, Meter. */
const EARTH_R = 6371008.8;
function toMeters(cal: Calibration | null, pts: LngLat[]): [number, number][] {
  if (cal) return pts.map(([lng, lat]) => lngLatToWorld(cal, lng, lat));
  if (!pts.length) return [];
  const lat0 = (pts[0][1] * Math.PI) / 180;
  const k = (Math.PI / 180) * EARTH_R;
  return pts.map(([lng, lat]) => [lng * k * Math.cos(lat0), lat * k]);
}

/**
 * Flächeninhalt eines Polygons in m² auf der Spielkarte (Gauß'sche Trapezformel in Welt-Metern
 * über die Karten-Kalibrierung, wie das Messen-Werkzeug). Weniger als 3 Punkte → 0.
 */
export function polygonAreaM2(pts: LngLat[], cal: Calibration | null): number {
  const p = toMeters(cal, openRing(pts));
  if (p.length < 3) return 0;
  let s = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]);
  return Math.abs(s / 2);
}

/** Flächeninhalt lesbar: unter 1 km² in m², sonst km² (deutsches Zahlenformat optional über ``locale``). */
export function formatArea(m2: number, locale?: string): string {
  if (!Number.isFinite(m2) || m2 <= 0) return "0 m²";
  if (m2 < 1e6) return `${Math.round(m2).toLocaleString(locale)} m²`;
  const km2 = m2 / 1e6;
  return `${km2.toLocaleString(locale, { maximumFractionDigits: km2 < 10 ? 2 : 1 })} km²`;
}

/**
 * Schwerpunkt [lng, lat]: Flächenschwerpunkt für geschlossene Flächen (≥ 3 Punkte, Fläche ≠ 0),
 * sonst Mittelpunkt der Linie (halbe Länge). Rechnet in lng/lat — für Beschriftung genügt das.
 */
export function areaCentroid(pts: LngLat[], closed = true): LngLat | null {
  const p = openRing(pts);
  if (!p.length) return null;
  if (closed && p.length >= 3) {
    // relativ zum ersten Punkt rechnen (numerisch stabiler)
    const [ox, oy] = p[0];
    let a = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const xi = p[i][0] - ox, yi = p[i][1] - oy, xj = p[j][0] - ox, yj = p[j][1] - oy;
      const f = xj * yi - xi * yj;
      a += f;
      cx += (xj + xi) * f;
      cy += (yj + yi) * f;
    }
    if (Math.abs(a) > 1e-18) return [ox + cx / (3 * a), oy + cy / (3 * a)];
  }
  if (p.length === 1) return p[0];
  // Linien-Mitte
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < p.length; i++) {
    const d = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    seg.push(d);
    total += d;
  }
  let half = total / 2;
  for (let i = 1; i < p.length; i++) {
    if (half <= seg[i - 1] || i === p.length - 1) {
      const t = seg[i - 1] > 0 ? Math.min(1, half / seg[i - 1]) : 0;
      return [p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t];
    }
    half -= seg[i - 1];
  }
  return p[0];
}
