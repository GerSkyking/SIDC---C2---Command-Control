// Wiederverwendbare Flächen-Hilfen für MapLibre (öffentliche Ansicht und Plan-Editor):
// Schraffur-Muster erzeugen/registrieren, Flächen-Layer (Füllung 25 %, Außenlinie 50 %) anlegen,
// GeoJSON aus Punktlisten bauen, Schwerpunkt und Flächeninhalt (m² auf der Spielkarte) berechnen.
// Punkte sind immer [lng, lat] wie bei Strokes und Annotation-Bereichen.
import type { GeoJSONSource, Map as MlMap } from "maplibre-gl";
import { getLang } from "./i18n";
import { iconUrl, lngLatToWorld, type Calibration } from "./sidc/sidc";
import { milsymbolImage } from "./sidc/symbol";

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

/** Zahlenformat der Oberfläche: deutsch mit Komma, englisch mit Punkt. */
export function uiLocale(): string {
  return getLang() === "de" ? "de-DE" : "en-US";
}

/**
 * Flächeninhalt lesbar, Staffelung: unter 1 ha in m² (ab 100 m² auf 10 m² gerundet), bis 50 ha in ha,
 * darüber in km² — z. B. „850 m²“, „2,4 ha“, „0,85 km²“. Ohne ``locale`` die Sprache der Oberfläche.
 */
export function formatArea(m2: number, locale: string = uiLocale()): string {
  if (!Number.isFinite(m2) || m2 <= 0) return "0 m²";
  const n = (v: number, d: number) => v.toLocaleString(locale, { maximumFractionDigits: d, minimumFractionDigits: 0 });
  if (m2 < 1e4) return `${n(m2 < 100 ? Math.round(m2) : Math.round(m2 / 10) * 10, 0)} m²`;
  if (m2 < 5e5) {
    const ha = m2 / 1e4;
    return `${n(ha, ha < 10 ? 1 : 0)} ha`;
  }
  const km2 = m2 / 1e6;
  return `${n(km2, km2 < 10 ? 2 : 1)} km²`;
}

/** Länge einer Linie in Metern auf der Spielkarte (2D, über die Kalibrierung). */
export function pathLengthM(pts: LngLat[], cal: Calibration | null, closed = false): number {
  const p = toMeters(cal, closed ? ringOf(openRing(pts)) : pts);
  let s = 0;
  for (let i = 1; i < p.length; i++) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return s;
}

/** Länge lesbar: unter 1 km in m, sonst km mit zwei Nachkommastellen. */
export function formatLength(m: number, locale: string = uiLocale()): string {
  if (!Number.isFinite(m) || m <= 0) return "0 m";
  if (m < 1000) return `${Math.round(m).toLocaleString(locale)} m`;
  return `${(m / 1000).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} km`;
}

/** Kurztext für einen Bereich: geschlossen → Fläche, offen → Länge, zu wenige Punkte → "". */
export function areaSizeText(pts: LngLat[], closed: boolean, cal: Calibration | null): string {
  const p = openRing(pts);
  if (closed && p.length >= 3) return formatArea(polygonAreaM2(p, cal));
  if (p.length >= 2) return formatLength(pathLengthM(p, cal));
  return "";
}

// ── Benannte Flächen: Name + SIDC-Symbol + Größe am Schwerpunkt ─────────

/** Bild-ID des Flächen-Symbols (eigener Namensraum, damit Marker-Icons/PNG-Ersatz nicht kollidieren). */
export function areaIconId(sidc: string): string {
  return `area|${sidc}`;
}

/**
 * SIDC-Symbol für eine Fläche registrieren — nur, wenn milsymbol es als Punktsymbol zeichnen kann
 * (Linien-/Flächen-Control-Measures liefern keins). Ergebnis: Bild-ID oder "" (dann nur der Name).
 */
export function ensureAreaIcon(map: MlMap, sidc: string): string {
  if (!sidc) return "";
  const id = areaIconId(sidc);
  if (map.hasImage(id)) return id;
  const img = milsymbolImage(sidc, 32);
  if (img) {
    map.addImage(id, img);
    return id;
  }
  // Wie bei den normalen Markern: vorgerendertes PNG als Rückfall (Linien-/Flächen-Symbole u. a.)
  if (areaIconFailed.has(id)) return "";
  if (!areaIconPending.has(id)) {
    areaIconPending.add(id);
    map
      .loadImage(iconUrl(sidc))
      .then((r) => {
        if (!map.hasImage(id)) map.addImage(id, r.data);
      })
      .catch(() => areaIconFailed.add(id))
      .finally(() => areaIconPending.delete(id));
  }
  return id; // MapLibre zeichnet das Symbol, sobald das Bild geladen ist
}
const areaIconPending = new Set<string>();
const areaIconFailed = new Set<string>();

/** Kann milsymbol das Symbol als Punktsymbol zeichnen? (Vorschau/Hinweis im Dialog) */
export function areaSymbolRenderable(sidc: string): boolean {
  return !!sidc && !!milsymbolImage(sidc, 32);
}

export interface AreaLabelInput {
  id: string;
  pts: LngLat[];
  name: string;
  sidc: string;
  /** Farbe "#rrggbb" (Text; Halo automatisch kontrastierend) */
  color: string;
  opacity: number;
  scale?: number;
  /** Zusatztext (aus dem Marker-Baukasten), unter dem Namen */
  ai?: string;
  /** Größe mit anzeigen (Standard: ja) */
  showSize?: boolean;
}

/** Kontrast-Halo zur Textfarbe: dunkel bei hellen Farben, hell bei dunklen. */
export function haloFor(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return "#000000";
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#000000" : "#ffffff";
}

/** Beschriftungs-Feature einer geschlossenen Fläche (Symbol über Name, darunter klein die Größe). */
export function areaLabelFeature(map: MlMap, a: AreaLabelInput, cal: Calibration | null): GeoJSON.Feature | null {
  const c = areaCentroid(a.pts, true);
  if (!c) return null;
  const icon = ensureAreaIcon(map, a.sidc);
  const size = a.showSize === false ? "" : areaSizeText(a.pts, true, cal);
  const name = [a.name, a.ai ?? ""].filter(Boolean).join("\n");
  if (!name && !icon && !size) return null;
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: c },
    properties: {
      id: a.id,
      name,
      size,
      sep: name && size ? "\n" : "",
      icon,
      hasIcon: !!icon,
      color: a.color,
      halo: haloFor(a.color),
      opacity: a.opacity,
      scale: a.scale ?? 1,
    },
  };
}

/** Symbol-Layer für Flächen-Beschriftungen (Quelle + Layer ``id``), identisch in Editor und öffentlicher Ansicht. */
export function ensureAreaLabelLayer(map: MlMap, id: string, before?: string): void {
  if (map.getSource(id)) return;
  map.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer(
    {
      id,
      type: "symbol",
      source: id,
      layout: {
        "icon-image": ["get", "icon"],
        "icon-size": ["*", 0.8, ["coalesce", ["get", "scale"], 1]],
        "icon-allow-overlap": true,
        "text-field": [
          "format",
          ["get", "name"], {},
          ["get", "sep"], {},
          ["get", "size"], { "font-scale": 0.78 },
        ],
        "text-size": 12,
        "text-line-height": 1.15,
        "text-anchor": ["case", ["get", "hasIcon"], "top", "center"],
        "text-offset": ["case", ["get", "hasIcon"], ["literal", [0, 1.5]], ["literal", [0, 0]]],
        "text-allow-overlap": true,
        "text-max-width": 16,
      },
      paint: {
        "icon-opacity": ["get", "opacity"],
        // Wie die Beschriftung der SIDC-Marker: weiße Schrift, schwarze Umrandung
        "text-color": "#e6e9ee",
        "text-halo-color": "#000",
        "text-halo-width": 1.4,
        "text-opacity": ["get", "opacity"],
      },
    } as never,
    before && map.getLayer(before) ? before : undefined,
  );
}

/** Beschriftungen setzen. */
export function setAreaLabels(map: MlMap, id: string, features: GeoJSON.Feature[]): void {
  (map.getSource(id) as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features });
}

// ── Einfache Punkte (Stroke kind "dot"): Kreis in Punktfarbe + Text daneben ─────────

/** Stroke-Art des Punkt-Werkzeugs. */
export const DOT_KIND = "dot";
/** Größen des Punkt-Werkzeugs (Radius in px, gespeichert als Stroke-width). */
export const DOT_SIZES = [5, 8, 12] as const;
export const DOT_DEFAULT_SIZE = 8;
/** Filter für Linien-Layer: Punkte nicht als Linie zeichnen. */
export const NOT_DOT_FILTER = ["!=", ["get", "kind"], DOT_KIND];

/** Kartenfeature eines Punkts; ``color`` "#rrggbb", ``size`` Radius in px. */
export function dotFeature(id: string, pt: LngLat, color: string, size: number, name: string, opacity: number): GeoJSON.Feature {
  const r = size > 0 ? Math.min(30, size) : DOT_DEFAULT_SIZE;
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: pt },
    properties: {
      id,
      kind: DOT_KIND,
      color,
      halo: haloFor(color),
      r,
      name,
      // Text rechts neben dem Kreis (Abstand in em bei 12 px Schrift)
      toff: [(r + 4) / 12, 0],
      opacity,
    },
  };
}

/**
 * Kreis- und Text-Layer für Punkte auf einer bestehenden Quelle (Features aus ``dotFeature``), identisch in
 * Editor und öffentlicher Ansicht: ``<prefix>`` (Kreis, dünner Kontrast-Rand) und ``<prefix>-labels``.
 */
export function addDotLayers(map: MlMap, source: string, prefix: string): void {
  if (map.getLayer(prefix)) return;
  const isDot = ["==", ["get", "kind"], DOT_KIND];
  map.addLayer({
    id: prefix,
    type: "circle",
    source,
    filter: isDot,
    paint: {
      "circle-radius": ["get", "r"],
      "circle-color": ["get", "color"],
      "circle-stroke-color": "#000",
      "circle-stroke-width": 1.5,
      "circle-opacity": ["get", "opacity"],
      "circle-stroke-opacity": ["get", "opacity"],
    },
  } as never);
  map.addLayer({
    id: `${prefix}-labels`,
    type: "symbol",
    source,
    filter: ["all", isDot, ["!=", ["get", "name"], ""]],
    layout: {
      "text-field": ["get", "name"],
      "text-size": 12,
      "text-anchor": "left",
      "text-justify": "left",
      "text-offset": ["get", "toff"],
      "text-allow-overlap": true,
      "text-max-width": 16,
    },
    paint: {
      // Wie die Beschriftung der SIDC-Marker: weiße Schrift, schwarze Umrandung
      "text-color": "#e6e9ee",
      "text-halo-color": "#000",
      "text-halo-width": 1.4,
      "text-opacity": ["get", "opacity"],
    },
  } as never);
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
