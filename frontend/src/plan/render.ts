// Kartendarstellung: GeoJSON-Quellen und Layer für Marker (Icon/Text/Richtungspfeile/Ketten), Phasenlinien,
// Linien-Entwurf, Lineal, Stützpunkte und Präsenz-Zeiger; dazu die Refresh-Funktionen und die
// Auswahl der gerade bearbeiteten Linie/Messlinie.
import type * as maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import { isTextMarker, markerLabelCategory } from "../sidc/sidc";
import { ensureMapIcon, mapIconId, markerLabelOffsets } from "../sidc/symbol";
import { areaFeatures, areaLabelFeature, ensureAreaLabelLayer, ensureAreaLayers, hatchId, ringOf, setAreaData, setAreaLabels } from "../mapAreas";
import { IS_MOBILE, type Marker, type PlanCtx, type Stroke } from "./ctx";
/** Geschlossene Linie mit mindestens 3 Punkten = Fläche. */
export const isStrokeArea = (s: Stroke): boolean => s.closed === true && (s.points?.length ?? 0) >= 3;
import { emptyFC, packedToHex } from "./geo";

export function initRender(ctx: PlanCtx): void {
  const { map, markers, strokes, peers } = ctx;
  const { markerLabel, phaseOpacity, multiPhaseOpacity, tacOpacity, unitAiOpacityExpr } = ctx.model;
  const loadedIcons = new Set<string>();
  const missingIcons = new Set<string>(); // weder milsymbol noch PNG → Ersatzpunkt
  // Icon-Id = SIDC (+ "|#farbe" bei eigener Markerfarbe)
  const iconIdOf = (m: Marker): string => mapIconId(m.sidc, isTextMarker(m.sidc) ? "" : m.tint || "");
  async function ensureIcon(m: Marker): Promise<void> {
    if (isTextMarker(m.sidc)) return; // Nur-Text-Marker hat kein Icon
    const id = iconIdOf(m);
    if (loadedIcons.has(id) || map.hasImage(id)) return;
    loadedIcons.add(id);
    const ok = await ensureMapIcon(map, m.sidc, m.tint || "");
    if (!ok) missingIcons.add(id);
  }

  const markerFC = (): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: [...markers.values()].map((m) => {
      const scale = Math.max(0.25, Math.min(3, m.scale ?? 1)) * ctx.personalScale;
      // Text-Offset aus der tatsächlichen Icon-Größe berechnet (0.8 = derselbe
      // Faktor wie in "icon-size" unten), damit der Text immer knapp außerhalb
      // des Icons sitzt statt eines geschätzten Fixwerts.
      const labelOff = markerLabelOffsets(m.sidc, 0.8 * scale, ctx.textScale);
      return {
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [m.world_x, m.world_y] },
        properties: {
          id: m.id,
          sidc: m.sidc,
          icon: iconIdOf(m),
          // Textfarbe (nur Nur-Text-Marker; sonst leer = Standardfarbe)
          tcolor: isTextMarker(m.sidc) ? m.tint || "" : "",
          istext: isTextMarker(m.sidc),
          // "default" (Land Unit u. a.) / "cm" (Punkt-Control-Measure) / "line"
          // (linienhaftes Control-Measure-Symbol, z. B. Phase Line) — bestimmt, wo
          // Einheitstext/Zusatztext relativ zum Symbol stehen.
          labelcat: markerLabelCategory(m.sidc),
          label: markerLabel(m),
          ai: m.ai_text || "",
          unitOff: labelOff.unit,
          aiOff: labelOff.ai,
          rot: m.icon_rotation || 0,
          locked: m.locked,
          dot: missingIcons.has(iconIdOf(m)) && !isTextMarker(m.sidc),
          opacity: phaseOpacity(m),
          scale,
        },
      };
    }),
  });

  // Richtungspfeile (rotation_degrees, 8 Richtungen à 45°, -1 = stationär) —
  // als Vektor-Geometrie nachgebaut wie in ATAKmaps (markersLayer.ts).
  const ICON_PX = 34;
  const isAir = (sidc: string) => sidc.slice(4, 6) === "01";
  const dirFC = (): { lines: GeoJSON.FeatureCollection; heads: GeoJSON.FeatureCollection } => {
    const lines: GeoJSON.Feature[] = [];
    const heads: GeoJSON.Feature[] = [];
    const p2ll = (x: number, y: number): [number, number] => {
      const ll = map.unproject([x, y]);
      return [ll.lng, ll.lat];
    };
    const headPoly = (tx: number, ty: number, dx: number, dy: number): GeoJSON.Feature => {
      const len = ICON_PX * 0.35;
      const wid = ICON_PX * 0.3;
      const bx = tx - dx * len;
      const by = ty - dy * len;
      const px = -dy;
      const py = dx;
      return {
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              p2ll(tx, ty),
              p2ll(bx + px * (wid / 2), by + py * (wid / 2)),
              p2ll(bx - px * (wid / 2), by - py * (wid / 2)),
              p2ll(tx, ty),
            ],
          ],
        },
        properties: {},
      };
    };
    for (const m of markers.values()) {
      const deg = m.rotation_degrees;
      if (deg == null || deg < 0) continue;
      const c = map.project([m.world_x, m.world_y]);
      const a = (deg * Math.PI) / 180;
      const dx = Math.sin(a);
      const dy = -Math.cos(a);
      if (isAir(m.sidc)) {
        const len = ICON_PX * 1.75;
        const ex = c.x + dx * len;
        const ey = c.y + dy * len;
        lines.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: [p2ll(c.x, c.y), p2ll(ex, ey)] },
          properties: {},
        });
        heads.push(headPoly(ex, ey, dx, dy));
      } else {
        const gx = c.x;
        const gy = c.y + ICON_PX * 0.65;
        const sx = gx;
        const sy = gy + ICON_PX;
        lines.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: [p2ll(gx, gy), p2ll(sx, sy)] },
          properties: {},
        });
        const ex = sx + dx * ICON_PX;
        const ey = sy + dy * ICON_PX;
        lines.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: [p2ll(sx, sy), p2ll(ex, ey)] },
          properties: {},
        });
        heads.push(headPoly(ex, ey, dx, dy));
      }
    }
    return {
      lines: { type: "FeatureCollection", features: lines },
      heads: { type: "FeatureCollection", features: heads },
    };
  };
  const strokeOpacity = (s: Stroke): number => multiPhaseOpacity(s.phase_id, s.extra_phase_ids) * tacOpacity(null, s.layer_id);
  const strokeFC = (): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: [...strokes.values()].map((s) => ({
      type: "Feature",
      // Geschlossene Fläche: Umriss = die Linie selbst als geschlossener Ring
      geometry: { type: "LineString", coordinates: isStrokeArea(s) ? ringOf(s.points) : s.points },
      properties: {
        id: s.id,
        color: packedToHex(s.color),
        width: s.width > 0 ? s.width : 2,
        opacity: strokeOpacity(s),
      },
    })),
  });
  // Benannte Flächen (geschlossene Strokes): Schraffur in Stroke-Farbe (entfällt bei fill:false) und
  // Name/Symbol/Größe am Schwerpunkt — gleiche Optik wie die öffentliche Ansicht (mapAreas.ts).
  const strokeAreaFC = (): GeoJSON.Feature[] => {
    const out: GeoJSON.Feature[] = [];
    for (const s of strokes.values()) {
      if (!isStrokeArea(s) || s.fill === false) continue;
      const op = strokeOpacity(s);
      if (op <= 0.001) continue;
      const color = packedToHex(s.color);
      out.push(...areaFeatures(s.points, true, { sid: s.id, color, pat: hatchId(color), op }).filter((f) => f.geometry.type === "Polygon"));
    }
    return out;
  };
  const strokeAreaLabelFC = (): GeoJSON.Feature[] =>
    [...strokes.values()].flatMap((s) => {
      if (!isStrokeArea(s)) return [];
      const op = strokeOpacity(s);
      if (op <= 0.001) return [];
      const f = areaLabelFeature(
        map,
        { id: s.id, pts: s.points, name: s.name || "", sidc: s.sidc || "", color: packedToHex(s.color), opacity: op, scale: ctx.personalScale },
        ctx.cal,
      );
      return f ? [f] : [];
    });
  // Verbindungslinien für Multipoint-Marker (gleiche linked_group_id, nach point_index)
  const chainFC = (): GeoJSON.FeatureCollection => {
    const byGroup = new Map<number, Marker[]>();
    for (const m of markers.values()) {
      if (m.linked_group_id != null && m.linked_group_id >= 0) {
        (byGroup.get(m.linked_group_id) ?? byGroup.set(m.linked_group_id, []).get(m.linked_group_id)!).push(m);
      }
    }
    // Endpunkte um ~16 px zum Nachbarn einrücken, damit das Icon frei bleibt.
    const trim = (from: [number, number], toward: [number, number], px: number): [number, number] => {
      const a = map.project(from);
      const b = map.project(toward);
      const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const f = Math.min(0.45, px / d);
      const ll = map.unproject([a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f]);
      return [ll.lng, ll.lat];
    };
    // Abstand zum Icon-Rand (skaliert mit der Icon-Größe des Markers) — groß
    // genug, dass das Symbol frei lesbar bleibt.
    const gapPx = (m: Marker) =>
      Math.max(38, 52 * Math.max(0.25, Math.min(3, m.scale ?? 1)) * ctx.personalScale);
    const feats: GeoJSON.Feature[] = [];
    for (const list of byGroup.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.point_index - b.point_index);
      const anchor = list[0];
      const color = packedToHex(anchor.line_color);
      const width = anchor.line_width > 0 ? anchor.line_width : 2;
      // Je Segment eine eigene Linie, an BEIDEN Enden vom jeweiligen Marker eingerückt.
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1];
        const b = list[i];
        const pa = [a.world_x, a.world_y] as [number, number];
        const pb = [b.world_x, b.world_y] as [number, number];
        feats.push({
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [trim(pa, pb, gapPx(a)), trim(pb, pa, gapPx(b))],
          },
          properties: {
            color,
            width,
            opacity: Math.min(phaseOpacity(a), phaseOpacity(b)),
          },
        });
      }
    }
    return { type: "FeatureCollection", features: feats };
  };

  const peerFC = (): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: [...peers.values()]
      .filter((p) => Date.now() - p.t < 5000 || p.arrow || p.hl === Infinity)
      .map((p) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.lng, p.lat] },
        properties: { name: p.name, color: p.color, hl: p.hl > Date.now() ? 1 : 0 },
      })),
  });

  // Zeige-Pfeile (nur solange die Person rechts klickt): Schaft in Geo-Koordinaten,
  // Spitze in Bildschirmgröße (konstant, unabhängig vom Zoom).
  const peerArrowFC = (): GeoJSON.FeatureCollection => {
    const feats: GeoJSON.Feature[] = [];
    const ll = (x: number, y: number): [number, number] => {
      const q = map.unproject([x, y]);
      return [q.lng, q.lat];
    };
    for (const p of peers.values()) {
      if (!p.arrow) continue;
      const a = map.project(p.arrow);
      const b = map.project([p.lng, p.lat]);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 6) continue;
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      const headLen = 18;
      const headW = 8;
      const bx = b.x - ux * headLen;
      const by = b.y - uy * headLen;
      feats.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [p.arrow, ll(bx, by)] },
        properties: { color: p.color },
      });
      feats.push({
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [[ll(b.x, b.y), ll(bx - uy * headW, by + ux * headW), ll(bx + uy * headW, by - ux * headW), ll(b.x, b.y)]],
        },
        properties: { color: p.color },
      });
    }
    return { type: "FeatureCollection", features: feats };
  };

  // Terrain-/Enfusion-Overlays müssen UNTER "strokes" eingefügt werden → erst nach dessen Anlage starten
  map.on("load", async () => {
    await Promise.all([...markers.values()].map(ensureIcon)).catch(() => {});

    map.addSource("strokes", { type: "geojson", data: strokeFC() });
    map.addLayer({
      id: "strokes",
      type: "line",
      source: "strokes",
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["get", "width"],
        "line-opacity": ["coalesce", ["get", "opacity"], 1],
      },
      layout: { "line-cap": "round", "line-join": "round" },
    });
    // Schraffur unter den Linien, Beschriftung darüber
    ensureAreaLayers(map, "stroke-areas", { before: "strokes" });
    ensureAreaLabelLayer(map, "stroke-area-labels");
    refreshStrokeAreas();
    ctx.strokesLayer.done();

    map.addSource("chains", { type: "geojson", data: chainFC() });
    map.addLayer({
      id: "chains",
      type: "line",
      source: "chains",
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["get", "width"],
        "line-opacity": ["coalesce", ["get", "opacity"], 1],
      },
      layout: { "line-cap": "round", "line-join": "round" },
    });

    map.addSource("strokeverts", { type: "geojson", data: emptyFC() });
    map.addLayer({
      id: "strokeverts",
      type: "circle",
      source: "strokeverts",
      paint: {
        "circle-radius": IS_MOBILE ? 11 : 8,
        "circle-color": "#ff9900",
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 2,
      },
    });
    // unsichtbare, größere Trefferfläche: Stützpunkte lassen sich leichter greifen und ziehen
    map.addLayer({
      id: "strokeverts-hit",
      type: "circle",
      source: "strokeverts",
      paint: { "circle-radius": IS_MOBILE ? 28 : 18, "circle-color": "#000", "circle-opacity": 0 },
    });

    map.addSource("linedraft", { type: "geojson", data: emptyFC() });
    map.addLayer({
      id: "linedraft",
      type: "line",
      source: "linedraft",
      paint: { "line-color": "#4c8dff", "line-width": 2, "line-dasharray": [2, 1] },
    });
    map.addLayer({
      id: "linedraft-pts",
      type: "circle",
      source: "linedraft",
      filter: ["==", ["geometry-type"], "Point"],
      // Startpunkt grün und größer, sobald ein Klick die Linie zur Fläche schließen würde
      paint: {
        "circle-radius": ["case", ["get", "hot"], 9, ["get", "first"], 5.5, 4],
        "circle-color": ["case", ["get", "hot"], "#3ddc84", "#4c8dff"],
        "circle-stroke-color": "#fff",
        "circle-stroke-width": ["case", ["get", "hot"], 2, 1],
      },
    });

    // Messwerkzeug (Lineal): gestrichelte Linie + Distanz-Label
    map.addSource("measure", { type: "geojson", data: emptyFC() });
    map.addLayer({
      id: "measure-line",
      type: "line",
      source: "measure",
      filter: ["==", ["get", "kind"], "line"],
      paint: {
        "line-color": "#ffd166",
        "line-width": 2,
        "line-dasharray": ["case", ["get", "dashed"], ["literal", [2, 2]], ["literal", [1, 0]]],
      },
    });
    map.addLayer({
      id: "measure-pts",
      type: "circle",
      source: "measure",
      filter: ["==", ["get", "kind"], "pt"],
      paint: { "circle-radius": 4, "circle-color": "#ffd166", "circle-stroke-color": "#000", "circle-stroke-width": 1 },
    });
    map.addLayer({
      id: "measure-label",
      type: "symbol",
      source: "measure",
      filter: ["==", ["get", "kind"], "label"],
      layout: { "text-field": ["get", "label"], "text-size": 13, "text-offset": [0, -0.8], "text-allow-overlap": true },
      paint: { "text-color": "#ffd166", "text-halo-color": "#000", "text-halo-width": 1.8 },
    });

    // Richtungspfeile (unter den Markern)
    map.addSource("dir-lines", { type: "geojson", data: emptyFC() });
    map.addSource("dir-heads", { type: "geojson", data: emptyFC() });
    map.addLayer({
      id: "dir-lines",
      type: "line",
      source: "dir-lines",
      paint: { "line-color": "#e6e9ee", "line-width": 2 },
      layout: { "line-cap": "round" },
    });
    map.addLayer({
      id: "dir-heads",
      type: "fill",
      source: "dir-heads",
      paint: { "fill-color": "#e6e9ee" },
    });

    map.addSource("markers", { type: "geojson", data: markerFC() });
    map.addLayer({
      id: "marker-dot",
      type: "circle",
      source: "markers",
      filter: ["==", ["get", "dot"], true],
      paint: {
        "circle-radius": 5,
        "circle-color": ["case", ["get", "locked"], "#8a8f98", "#4c8dff"],
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 1.5,
        "circle-opacity": ["get", "opacity"],
        "circle-stroke-opacity": ["get", "opacity"],
      },
    });
    map.addLayer({
      id: "marker-icon",
      type: "symbol",
      source: "markers",
      filter: ["!=", ["get", "istext"], true],
      layout: {
        "icon-image": ["get", "icon"],
        "icon-size": ["*", 0.8, ["coalesce", ["get", "scale"], 1]],
        "icon-rotate": ["get", "rot"],
        "icon-allow-overlap": true,
        // "allow-overlap" verhindert nur, dass das Icon SELBST versteckt wird —
        // ohne "ignore-placement" blockiert es weiterhin die eng danebensitzenden
        // Einheitstext-/Zusatztext-Layer (die kollidieren sonst mit der Icon-Box
        // und werden von MapLibre verworfen, statt einfach übereinandergezeichnet).
        "icon-ignore-placement": true,
      },
      paint: {
        "icon-opacity": ["*", ["case", ["get", "locked"], 0.6, 1], ["get", "opacity"]],
      },
    });
    // Einheitstext (unit_text + SIDC-Modifikatoren) und Zusatztext (ai_text) als
    // eigene Text-Layer, je Marker-Kategorie unterschiedlich positioniert:
    // - "default" (Land Unit u. a.): Zusatztext rechts/mittig/linksbündig,
    //   Einheitstext links vom Symbol/rechtsbündig, mittig zwischen Icon-Mitte
    //   und Icon-Unterkante.
    // - "cm" (Punkt-Control-Measure, z. B. Known Point): Zusatztext oben/
    //   zentriert, Einheitstext rechts vom Symbol im oberen/mittleren Bereich,
    //   linksbündig.
    // - "line" (linienhaftes Control-Measure-Symbol, z. B. Phase Line/Boundary/
    //   CFL): Einheitstext oben/zentriert, Zusatztext unten/zentriert.
    const UNIT_TEXT_ANCHOR: maplibregl.ExpressionSpecification = [
      "match", ["get", "labelcat"],
      "line", "bottom",
      "cm", "left",
      "text", "center",
      "right",
    ];
    // Offset selbst kommt NICHT mehr aus einer geschätzten Konstante, sondern
    // wird pro Marker aus der tatsächlichen Icon-Größe berechnet (unitOff/aiOff
    // in markerFC(), via markerLabelOffsets) — der Text sitzt damit immer knapp
    // außerhalb des Icons, egal wie groß/klein es skaliert ist.
    const UNIT_TEXT_OFFSET: maplibregl.ExpressionSpecification = ["get", "unitOff"];
    const AI_TEXT_ANCHOR: maplibregl.ExpressionSpecification = [
      "match", ["get", "labelcat"],
      "line", "top",
      "cm", "bottom",
      "text", "top",
      "left",
    ];
    const AI_TEXT_OFFSET: maplibregl.ExpressionSpecification = ["get", "aiOff"];
    const UNIT_TEXT_JUSTIFY: maplibregl.ExpressionSpecification = [
      "match", ["get", "labelcat"],
      "line", "center",
      "text", "center",
      "cm", "left",
      "right",
    ];
    const AI_TEXT_JUSTIFY: maplibregl.ExpressionSpecification = [
      "match", ["get", "labelcat"],
      "line", "center",
      "cm", "center",
      "text", "center",
      "left",
    ];
    map.addLayer({
      id: "marker-unittext",
      type: "symbol",
      source: "markers",
      filter: ["!=", ["get", "istext"], true],
      layout: {
        "text-field": ["get", "label"],
        "text-size": 11 * ctx.textScale,
        "text-anchor": UNIT_TEXT_ANCHOR,
        "text-offset": UNIT_TEXT_OFFSET,
        "text-justify": UNIT_TEXT_JUSTIFY,
        // Im Original-HUD werden Einheitstext/Zusatztext nie wegen Platzmangel
        // ausgeblendet — anders als Kartenbeschriftungen. Sonst verwirft MapLibre
        // sonst eins der beiden dicht beieinanderliegenden Textfelder.
        "text-allow-overlap": true,
        "icon-allow-overlap": true,
      },
      paint: {
        "text-color": ["case", ["!=", ["get", "tcolor"], ""], ["get", "tcolor"], "#e6e9ee"],
        "text-halo-color": "#000",
        "text-halo-width": 1.4,
        "text-opacity": unitAiOpacityExpr(ctx.showUnitAiLabels),
      },
    });
    // Nur-Text-Marker ("Spezial"): kein Symbol, nur der Text — eigene Farbe, immer sichtbar.
    map.addLayer({
      id: "marker-textmark",
      type: "symbol",
      source: "markers",
      filter: ["==", ["get", "istext"], true],
      layout: {
        "text-field": ["get", "label"],
        "text-size": 14 * ctx.textScale,
        "text-anchor": "center",
        "text-justify": "center",
        "text-allow-overlap": true,
        "text-max-width": 20,
      },
      paint: {
        "text-color": ["case", ["!=", ["get", "tcolor"], ""], ["get", "tcolor"], "#e6e9ee"],
        "text-halo-color": "#000",
        "text-halo-width": 1.6,
        "text-opacity": ["get", "opacity"],
      },
    });
    map.addLayer({
      id: "marker-aitext",
      type: "symbol",
      source: "markers",
      layout: {
        "text-field": ["get", "ai"],
        "text-size": 11 * ctx.textScale,
        "text-anchor": AI_TEXT_ANCHOR,
        "text-offset": AI_TEXT_OFFSET,
        "text-justify": AI_TEXT_JUSTIFY,
        "text-allow-overlap": true,
        "icon-allow-overlap": true,
      },
      paint: {
        "text-color": "#e6e9ee",
        "text-halo-color": "#000",
        "text-halo-width": 1.4,
        "text-opacity": unitAiOpacityExpr(ctx.showUnitAiLabels),
      },
    });

    map.addSource("peers", { type: "geojson", data: peerFC() });
    map.addSource("peer-arrows", { type: "geojson", data: peerArrowFC() });
    map.addLayer({
      id: "peer-arrows-line",
      type: "line",
      source: "peer-arrows",
      filter: ["==", ["geometry-type"], "LineString"],
      paint: { "line-color": ["get", "color"], "line-width": 4 },
      layout: { "line-cap": "round" },
    });
    map.addLayer({
      id: "peer-arrows-head",
      type: "fill",
      source: "peer-arrows",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": ["get", "color"] },
    });
    map.addLayer({
      id: "peers",
      type: "circle",
      source: "peers",
      paint: {
        "circle-radius": ["case", ["==", ["get", "hl"], 1], 9, 6],
        "circle-color": ["get", "color"],
        "circle-stroke-color": ["case", ["==", ["get", "hl"], 1], "#ffe600", "#fff"],
        "circle-stroke-width": ["case", ["==", ["get", "hl"], 1], 15, 2],
        "circle-stroke-opacity": ["case", ["==", ["get", "hl"], 1], 0.75, 1],
      },
    });
    map.addLayer({
      id: "peers-label",
      type: "symbol",
      source: "peers",
      layout: { "text-field": ["get", "name"], "text-size": 11, "text-offset": [0, 1.2] },
      paint: { "text-color": ["get", "color"], "text-halo-color": "#000", "text-halo-width": 1.5 },
    });

    // Start in 2D: KEIN Terrain-Mesh (ressourcenschonend). Die Cursor-Höhe kommt
    // in 2D aus den DEM-Kacheln (sampleElevation), in 3D aus dem Terrain.
  });

  const refreshDir = () => {
    const d = dirFC();
    (map.getSource("dir-lines") as GeoJSONSource)?.setData(d.lines);
    (map.getSource("dir-heads") as GeoJSONSource)?.setData(d.heads);
  };
  ctx.ui.refreshChains = () => (map.getSource("chains") as GeoJSONSource)?.setData(chainFC());
  ctx.ui.redrawMarkersOnly = () => {
    (map.getSource("markers") as GeoJSONSource)?.setData(markerFC());
    (map.getSource("chains") as GeoJSONSource)?.setData(chainFC());
    refreshDir();
  };
  const refreshStrokeAreas = () => {
    if (!map.getSource("stroke-areas")) return;
    setAreaData(map, "stroke-areas", strokeAreaFC());
    setAreaLabels(map, "stroke-area-labels", strokeAreaLabelFC());
  };
  const refreshStrokes = () => {
    (map.getSource("strokes") as GeoJSONSource)?.setData(strokeFC());
    refreshStrokeAreas();
  };
  const refreshMarkers = async () => {
    await Promise.all([...markers.values()].map(ensureIcon));
    (map.getSource("markers") as GeoJSONSource)?.setData(markerFC());
    (map.getSource("chains") as GeoJSONSource)?.setData(chainFC());
    refreshDir();
    refreshStrokes(); // Phase/Channel steuern auch die Deckkraft der Linien
  };

  // ── Linien nachträglich bearbeiten: Stützpunkte ziehen ───────────────
  // Lineal: mehrsegmentige, bleibende Messlinien (nur lokal, je Sitzung)
  // builder=true → nur in der Missionsbau-Ebene sichtbar, sonst nur in der Spieler-Ebene
  // Lineal-Zustand (measureLines/measureActive/…) liegt in ctx
  const editPts = (): [number, number][] | undefined =>
    ctx.editMeasureId
      ? ctx.measureLines.find((x) => x.id === ctx.editMeasureId)?.pts
      : ctx.editStrokeId
        ? strokes.get(ctx.editStrokeId)?.points
        : undefined;
  const refreshStrokeVerts = () => {
    (map.getSource("strokeverts") as GeoJSONSource)?.setData({
      type: "FeatureCollection",
      features: (editPts() ?? []).map((pt, i) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: pt },
        properties: { i },
      })),
    });
  };
  const setEditStroke = (id: string | null) => {
    ctx.editStrokeId = id;
    if (id) ctx.editMeasureId = null;
    refreshStrokeVerts();
    ctx.ui.positionLineDone();
  };
  const setEditMeasure = (id: string | null) => {
    ctx.editMeasureId = id;
    if (id) ctx.editStrokeId = null;
    refreshStrokeVerts();
    ctx.ui.positionLineDone();
  };
  const refreshPeers = () => {
    (map.getSource("peers") as GeoJSONSource)?.setData(peerFC());
    (map.getSource("peer-arrows") as GeoJSONSource)?.setData(peerArrowFC());
  };
  Object.assign(ctx.ui, { refreshMarkers, refreshStrokes, refreshDir, refreshStrokeVerts, setEditStroke, setEditMeasure, editPts, refreshPeers });
  // Hervorhebung läuft aus / Zeiger verschwindet, auch ohne neue Nachricht
  const peerTick = window.setInterval(() => peers.size && refreshPeers(), 500);
  window.addEventListener("hashchange", () => window.clearInterval(peerTick), { once: true });
  map.on("move", () => {
    if ([...peers.values()].some((p) => p.arrow)) refreshPeers(); // Pfeilspitze hat feste Bildschirmgröße
  });
  let dirRaf = 0;
  map.on("move", () => {
    if (dirRaf) return;
    dirRaf = requestAnimationFrame(() => {
      dirRaf = 0;
      refreshDir();
    });
  });
  map.on("load", refreshDir);
}
