// Plan-Ansicht: Karte + Werkzeugleiste + HUD + Marker/Zeichnen/Präsenz live.
// Nähert sich der ATAKmaps-UI an (D:\Mods\ATAKmaps).
import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import { api, type Me } from "./api";
import { channelLabel, loadAllMarkers, loadChannels, loadModifiers, loadPhaseLineStyle } from "./sidc/catalog";
import { lngLatToWorld, withModifiers, worldToLngLat, type Calibration, type SidcModifiers } from "./sidc/sidc";
import { openWizard, type MarkerTemplate } from "./sidc/wizard";
import { ensureMapIcon, iconSrc } from "./sidc/symbol";
import { openAclEditor } from "./acl";
import { openHelp } from "./help";
import { openVersionPanel } from "./versions";
import { t } from "./i18n";
import { cid, PlanSocket, type WsMessage } from "./ws";
import { renderMarkdown } from "./md";

interface Marker {
  id: string;
  world_x: number;
  world_y: number;
  sidc: string;
  unit_text: string;
  ai_text: string;
  channel: string;
  locked: boolean;
  rotation_degrees: number;
  icon_rotation: number;
  phase_id: string | null;
  layer_id: string | null;
  linked_group_id: number;
  point_index: number;
  line_color: number;
  line_width: number;
}
interface Stroke {
  id: string;
  points: [number, number][];
  color: number;
  width: number;
}
type Mode = "move" | "markermove" | "point" | "line" | "erase" | "place" | "measure";

export async function openPlanView(root: HTMLElement, planId: string, me: Me): Promise<void> {
  const snap = await api.snapshot(planId);
  const mapId: string = snap.plan.map_id;
  const cal: Calibration | null = snap.map_meta?.calibration ?? null;
  const markers = new Map<string, Marker>(snap.markers.map((m: Marker) => [m.id, m]));
  const strokes = new Map<string, Stroke>(snap.strokes.map((s: Stroke) => [s.id, s]));
  const myPlan = (await api.plans()).find((p) => p.id === planId);
  const canEdit = myPlan?.level === "editor" || myPlan?.level === "owner";
  const channels = await loadChannels();
  const lineStyle = await loadPhaseLineStyle();
  const modCat = await loadModifiers();
  // SIDC (Symbolset + Entity) → subCategory, um die Modifikatoren eines
  // platzierten Markers im Bearbeiten-Panel zu kennen.
  const subCatBySidc = new Map<string, string>();
  for (const c of (await loadAllMarkers()) ?? [])
    for (const e of c.entries)
      if (e.subCategory) subCatBySidc.set(e.sidc.slice(4, 6) + e.sidc.slice(10, 16), e.subCategory);
  const lineColors = lineStyle?.colors ?? [
    { name: "Gelb", red: 255, green: 255, blue: 0, packedColor: -256, isDefault: true },
    { name: "Rot", red: 255, green: 0, blue: 0, packedColor: -65536, isDefault: false },
  ];
  const lineWidths = lineStyle?.widths ?? [{ width: 2, isDefault: true }, { width: 4, isDefault: false }];
  let lineColor = (lineColors.find((c) => c.isDefault) ?? lineColors[0]).packedColor;
  let lineWidth = (lineWidths.find((w) => w.isDefault) ?? lineWidths[0]).width;

  const peers = new Map<string, { name: string; lng: number; lat: number; t: number }>();
  const caps = { place: canEdit, move: canEdit, delete: canEdit, draw: canEdit };
  let mode: Mode = "move";
  let pending: MarkerTemplate | null = null;
  let myChannel = channels?.currentChannel ?? "";
  let is3D = false;

  // Phasen / Zeitstrahl
  interface PhaseT {
    id: string;
    name: string;
    ordering: number;
    notes: string;
  }
  const phases: PhaseT[] = [...(snap.phases ?? [])].sort((a: PhaseT, b: PhaseT) => a.ordering - b.ordering);
  let currentPhaseId: string = phases[0]?.id ?? "";
  let outOpacity = Number(localStorage.getItem("sidc_phaseopacity") ?? "20"); // % fremde Phasen
  if (!Number.isFinite(outOpacity)) outOpacity = 20;
  const phaseListeners: (() => void)[] = []; // z. B. Notiz-Fenster bei Phasenwechsel
  const phaseOpacity = (m: Marker): number =>
    m.phase_id == null || m.phase_id === currentPhaseId ? 1 : Math.max(0, Math.min(100, outOpacity)) / 100;

  root.innerHTML = `
    <div class="topbar">
      <a href="#/">←</a>
      <strong>${snap.plan.name}</strong>
      <span class="badge">${myPlan?.level ?? "?"}</span>
      <button id="t3d">3D</button>
      <button id="compass" class="compass" title="${t("map.compass")}"><span>↑</span></button>
      <input type="datetime-local" id="dtg" title="${t("map.dtg")}" />
      <button id="shot" title="${t("map.screenshot")}">📷</button>
      <select id="chan" title="${t('map.channel')}">${(channels?.channels ?? [])
        .map((c) => `<option value="${c.name}" ${c.name === myChannel ? "selected" : ""}>${channelLabel(c)}</option>`)
        .join("")}</select>
      <div id="timeline" class="timeline"></div>
      <button id="notesBtn" title="${t("notes.open")}">🗒️</button>
      <select id="maplang" title="${t("map.lang")}"></select>
      <button id="layersBtn" title="${t("tool.layers")}">☰</button>
      <span class="grow"></span>
      <span class="presence" id="presence"></span>
      <button id="versions" title="${t("versions.open")}">🕑</button>
      <button id="help" title="${t("help.open")}">?</button>
      ${myPlan?.level === "owner" ? `<button id="acl">${t("plans.shares")}</button>` : ""}
    </div>
    <div id="map"></div>
    ${
      canEdit
        ? `<div class="toolbar" id="toolbar">
             <button data-mode="move" class="active" title="${t("tool.move")}">✋</button>
             <button data-mode="markermove" title="${t("tool.markermove")}">✥</button>
             <button data-mode="point" title="${t("tool.point")}">👉</button>
             <button data-mode="line" title="${t("tool.line")}">✏️</button>
             <button data-mode="measure" title="${t("tool.measure")}">📏</button>
             <button data-mode="erase" title="${t("tool.erase")}">🧽</button>
             <button id="tool-marker" title="${t("tool.marker")}">📍</button>
             <button id="tool-fav" title="${t("tool.fav")}">★</button>
           </div>
           <div class="fav-panel" id="favPanel" hidden></div>
           <div class="line-style" id="lineStyle" hidden>
             <div class="fav-head">${t("line.heading")}</div>
             <label>${t("line.color")}</label>
             <div id="lc" class="line-colors"></div>
             <label>${t("line.width")}</label>
             <select id="lw">${lineWidths
               .map((w) => `<option value="${w.width}" ${w.width === lineWidth ? "selected" : ""}>${w.width}</option>`)
               .join("")}</select>
             <button class="primary" id="lineFinish">${t("line.finish")}</button>
             <button id="lineCancel">${t("common.cancel")}</button>
           </div>`
        : ""
    }
    <div class="hud" id="hud">X: –  Y: –  H: –</div>
    <div class="layers-panel" id="layersPanel" hidden></div>
    <canvas class="grid-canvas" id="gridCanvas"></canvas>`;

  const map = new maplibregl.Map({
    container: "map",
    style: `/api/maps/${mapId}/style.json`,
    maxPitch: 0, // 2D: nur Drehen, kein Kippen — der 3D-Schalter hebt das an
    canvasContextAttributes: { preserveDrawingBuffer: true }, // für Screenshots (toDataURL)
    attributionControl: false, // kein MapLibre-Logo / Attribution-Box
    transformRequest: (url) =>
      url.startsWith("/") || url.startsWith(location.origin) ? { url, credentials: "include" } : { url },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

  // Kamera-Grenzen: nicht endlos von der Karte wegscrollen/-zoomen (wie ATAKmaps).
  function applyCameraBounds(): void {
    const src = (map.getStyle()?.sources ?? {}) as Record<string, { bounds?: number[] }>;
    const b = src.sat?.bounds ?? src.grid?.bounds;
    if (!b || b.length !== 4) return;
    const padX = (b[2] - b[0]) * 0.12;
    const padY = (b[3] - b[1]) * 0.12;
    map.setMaxBounds([
      [b[0] - padX, b[1] - padY],
      [b[2] + padX, b[3] + padY],
    ]);
    const cam = map.cameraForBounds(
      [
        [b[0], b[1]],
        [b[2], b[3]],
      ],
      { padding: 20 },
    );
    if (cam?.zoom) map.setMinZoom(Math.max(0, cam.zoom - 0.5));
  }
  map.on("load", applyCameraBounds);
  map.on("style.load", applyCameraBounds);

  const loadedIcons = new Set<string>();
  const missingIcons = new Set<string>(); // weder milsymbol noch PNG → Ersatzpunkt
  async function ensureIcon(sidc: string): Promise<void> {
    if (loadedIcons.has(sidc) || map.hasImage(sidc)) return;
    loadedIcons.add(sidc);
    const ok = await ensureMapIcon(map, sidc);
    if (!ok) missingIcons.add(sidc);
  }

  const markerFC = (): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: [...markers.values()].map((m) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [m.world_x, m.world_y] },
      properties: {
        id: m.id,
        sidc: m.sidc,
        label: m.unit_text || m.ai_text || "",
        rot: m.icon_rotation || 0,
        locked: m.locked,
        dot: missingIcons.has(m.sidc),
        opacity: phaseOpacity(m),
      },
    })),
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
  const strokeFC = (): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: [...strokes.values()].map((s) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: s.points },
      properties: { id: s.id, color: packedToHex(s.color), width: s.width > 0 ? s.width : 2 },
    })),
  });
  // Verbindungslinien für Multipoint-Marker (gleiche linked_group_id, nach point_index)
  const chainFC = (): GeoJSON.FeatureCollection => {
    const byGroup = new Map<number, Marker[]>();
    for (const m of markers.values()) {
      if (m.linked_group_id != null && m.linked_group_id >= 0) {
        (byGroup.get(m.linked_group_id) ?? byGroup.set(m.linked_group_id, []).get(m.linked_group_id)!).push(m);
      }
    }
    const feats: GeoJSON.Feature[] = [];
    for (const list of byGroup.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.point_index - b.point_index);
      const anchor = list[0];
      feats.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: list.map((m) => [m.world_x, m.world_y]) },
        properties: {
          color: packedToHex(anchor.line_color),
          width: anchor.line_width > 0 ? anchor.line_width : 2,
        },
      });
    }
    return { type: "FeatureCollection", features: feats };
  };

  const peerFC = (): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: [...peers.values()]
      .filter((p) => Date.now() - p.t < 5000)
      .map((p) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.lng, p.lat] },
        properties: { name: p.name },
      })),
  });

  map.on("load", async () => {
    await Promise.all([...new Set([...markers.values()].map((m) => m.sidc))].map(ensureIcon));

    map.addSource("strokes", { type: "geojson", data: strokeFC() });
    map.addLayer({
      id: "strokes",
      type: "line",
      source: "strokes",
      paint: { "line-color": ["get", "color"], "line-width": ["get", "width"] },
      layout: { "line-cap": "round", "line-join": "round" },
    });

    map.addSource("chains", { type: "geojson", data: chainFC() });
    map.addLayer({
      id: "chains",
      type: "line",
      source: "chains",
      paint: { "line-color": ["get", "color"], "line-width": ["get", "width"] },
      layout: { "line-cap": "round", "line-join": "round" },
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
      paint: { "circle-radius": 4, "circle-color": "#4c8dff", "circle-stroke-color": "#fff", "circle-stroke-width": 1 },
    });

    // Messwerkzeug (Lineal): gestrichelte Linie + Distanz-Label
    map.addSource("measure", { type: "geojson", data: emptyFC() });
    map.addLayer({
      id: "measure-line",
      type: "line",
      source: "measure",
      filter: ["==", ["get", "kind"], "line"],
      paint: { "line-color": "#ffd166", "line-width": 2, "line-dasharray": [2, 2] },
    });
    map.addLayer({
      id: "measure-pts",
      type: "circle",
      source: "measure",
      filter: ["all", ["==", ["geometry-type"], "Point"], ["!=", ["get", "kind"], "label"]],
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
      layout: {
        "icon-image": ["get", "sidc"],
        "icon-size": 0.8,
        "icon-rotate": ["get", "rot"],
        "icon-allow-overlap": true,
        "text-field": ["get", "label"],
        "text-optional": true,
        "text-size": 11,
        "text-offset": [0, 1.6],
        "text-allow-overlap": false,
      },
      paint: {
        "text-color": "#e6e9ee",
        "text-halo-color": "#000",
        "text-halo-width": 1.4,
        "text-opacity": ["get", "opacity"],
        "icon-opacity": ["*", ["case", ["get", "locked"], 0.6, 1], ["get", "opacity"]],
      },
    });

    map.addSource("peers", { type: "geojson", data: peerFC() });
    map.addLayer({
      id: "peers",
      type: "circle",
      source: "peers",
      paint: { "circle-radius": 6, "circle-color": "#ff5bd0", "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
    });
    map.addLayer({
      id: "peers-label",
      type: "symbol",
      source: "peers",
      layout: { "text-field": ["get", "name"], "text-size": 11, "text-offset": [0, 1.2] },
      paint: { "text-color": "#ff9be4", "text-halo-color": "#000", "text-halo-width": 1 },
    });

    // Terrain immer aktiv (falls DEM vorhanden), damit die Cursor-Höhe auch in 2D
    // abgefragt werden kann. Der 2D/3D-Schalter ändert nur Pitch + Überhöhung.
    if (map.getSource("terrain-dem")) {
      map.setTerrain({ source: "terrain-dem", exaggeration: 1 });
    }
  });

  const refreshDir = () => {
    const d = dirFC();
    (map.getSource("dir-lines") as GeoJSONSource)?.setData(d.lines);
    (map.getSource("dir-heads") as GeoJSONSource)?.setData(d.heads);
  };
  const refreshMarkers = async () => {
    await Promise.all([...new Set([...markers.values()].map((m) => m.sidc))].map(ensureIcon));
    (map.getSource("markers") as GeoJSONSource)?.setData(markerFC());
    (map.getSource("chains") as GeoJSONSource)?.setData(chainFC());
    refreshDir();
  };
  const refreshStrokes = () => (map.getSource("strokes") as GeoJSONSource)?.setData(strokeFC());
  const refreshPeers = () => (map.getSource("peers") as GeoJSONSource)?.setData(peerFC());
  let dirRaf = 0;
  map.on("move", () => {
    if (dirRaf) return;
    dirRaf = requestAnimationFrame(() => {
      dirRaf = 0;
      refreshDir();
    });
  });
  map.on("load", refreshDir);

  // ── WebSocket ──────────────────────────────────────────────────────────
  const socket = new PlanSocket(planId);
  const presenceEl = root.querySelector<HTMLSpanElement>("#presence")!;
  const names = new Map<string, string>();
  const renderPresence = () =>
    (presenceEl.innerHTML = [...names.values()].map((n) => `<span class="badge">${n}</span>`).join(""));

  socket.on((msg: WsMessage) => {
    switch (msg.type) {
      case "hello":
        Object.assign(caps, msg.caps);
        applyCaps();
        break;
      case "reject":
        if (msg.reason) console.warn("abgelehnt:", msg.reason);
        break;
      case "presence.join":
        if (msg.uid !== me.id) names.set(msg.uid, msg.user);
        renderPresence();
        break;
      case "presence.leave":
        names.delete(msg.uid);
        peers.delete(msg.uid);
        renderPresence();
        refreshPeers();
        break;
      case "presence.cursor":
        if (msg.uid !== me.id) {
          peers.set(msg.uid, { name: names.get(msg.uid) ?? "?", lng: msg.lng, lat: msg.lat, t: Date.now() });
          refreshPeers();
        }
        break;
      case "marker.upsert":
        markers.set(msg.marker.id, msg.marker);
        void refreshMarkers();
        break;
      case "marker.delete":
        markers.delete(msg.id);
        void refreshMarkers();
        break;
      case "stroke.upsert":
        strokes.set(msg.stroke.id, msg.stroke);
        refreshStrokes();
        break;
      case "stroke.delete":
        strokes.delete(msg.id);
        refreshStrokes();
        break;
    }
  });
  socket.connect();
  window.addEventListener("hashchange", () => socket.close(), { once: true });

  // ── HUD (Cursor X/Y/Höhe) ──────────────────────────────────────────────
  const hud = root.querySelector<HTMLDivElement>("#hud")!;
  let lastCursorSent = 0;
  map.on("mousemove", (e) => {
    const [wx, wy] = lngLatToWorld(cal, e.lngLat.lng, e.lngLat.lat);
    let h = "–";
    try {
      const el = map.queryTerrainElevation(e.lngLat);
      if (el != null) h = `${(el / (is3D ? 1.5 : 1)).toFixed(0)} m`;
    } catch {
      /* kein Terrain */
    }
    hud.textContent = `X: ${wx.toFixed(0)}  Y: ${wy.toFixed(0)}  H: ${h}`;
    if (mode === "point" && Date.now() - lastCursorSent > 60) {
      lastCursorSent = Date.now();
      socket.send({ type: "presence.cursor", lng: e.lngLat.lng, lat: e.lngLat.lat });
    }
  });

  // ── 2D/3D ─────────────────────────────────────────────────────────────
  root.querySelector("#t3d")!.addEventListener("click", () => {
    is3D = !is3D;
    root.querySelector("#t3d")!.classList.toggle("active", is3D);
    // Terrain bleibt gesetzt (für die Höhenabfrage) — nur Überhöhung + Kamera ändern sich.
    if (map.getSource("terrain-dem")) {
      map.setTerrain({ source: "terrain-dem", exaggeration: is3D ? 1.5 : 1 });
    }
    if (is3D) {
      map.setMaxPitch(85);
      map.easeTo({ pitch: 60, duration: 700 });
    } else {
      map.easeTo({ pitch: 0, duration: 700 });
      map.once("moveend", () => {
        if (!is3D) map.setMaxPitch(0); // Kippen wieder sperren, Drehung bleibt
      });
    }
  });

  // ── Kompass + Nach-Norden-Button ──────────────────────────────────────
  const compass = root.querySelector<HTMLButtonElement>("#compass")!;
  const syncCompass = () => {
    compass.style.setProperty("--rot", `${-map.getBearing()}deg`);
  };
  map.on("rotate", syncCompass);
  map.on("load", syncCompass);
  compass.addEventListener("click", () => map.easeTo({ bearing: 0, duration: 400 }));

  // ── Datum/Zeit (DTG) für den Screenshot ───────────────────────────────
  const dtgInput = root.querySelector<HTMLInputElement>("#dtg")!;
  const DTG_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const p2 = (n: number) => String(n).padStart(2, "0");
  const shotDate = () => (dtgInput.value ? new Date(dtgInput.value) : new Date());
  // Militärisches Format "DDHHMMZ MMM YY" (eingegebene Zeit als Zulu gelesen).
  const militaryDtg = (d: Date) =>
    `${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}Z ${DTG_MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}`;

  // ── Screenshot: nur Karteninhalt (Sat/Grid + Orte + Marker + Zeichnungen
  //    + Richtungspfeile), keine Bedienelemente. Unten links der DTG.
  const shotBtn = root.querySelector<HTMLButtonElement>("#shot")!;
  shotBtn.addEventListener("click", async () => {
    shotBtn.disabled = true;
    try {
      await new Promise<void>((res) => {
        if (map.loaded() && !map.isMoving()) return res();
        map.once("idle", () => res());
        map.triggerRepaint();
      });
      map.redraw(); // synchroner Vollframe → Puffer enthält alle GL-Layer
      const mc = map.getCanvas();
      const out = document.createElement("canvas");
      out.width = mc.width;
      out.height = mc.height;
      const ctx = out.getContext("2d")!;
      ctx.drawImage(mc, 0, 0);
      if (baseLayerVisible.grid !== false) ctx.drawImage(gridCanvas, 0, 0, out.width, out.height);

      const d = shotDate();
      const dpr = window.devicePixelRatio || 1;
      ctx.font = `bold ${Math.round(15 * dpr)}px monospace`;
      ctx.textBaseline = "bottom";
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.fillStyle = "#fff";
      const label = militaryDtg(d);
      const x = 12 * dpr;
      const y = out.height - 12 * dpr;
      ctx.strokeText(label, x, y);
      ctx.fillText(label, x, y);

      const phaseName = phases.find((p) => p.id === currentPhaseId)?.name ?? "global";
      const safe = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "map";
      const fileStamp =
        `${p2(d.getDate())}${p2(d.getMonth() + 1)}${d.getFullYear()}-` +
        `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
      const a = document.createElement("a");
      a.href = out.toDataURL("image/png");
      a.download = `${safe(snap.plan.name)}_${safe(phaseName)}_${fileStamp}.png`;
      a.click();
    } finally {
      shotBtn.disabled = false;
    }
  });

  root.querySelector("#acl")?.addEventListener("click", () => openAclEditor(planId, snap.plan.name));
  root.querySelector("#help")!.addEventListener("click", openHelp);
  root
    .querySelector("#versions")!
    .addEventListener("click", () => openVersionPanel(planId, canEdit, myPlan?.level === "owner"));

  // ── Zeitstrahl / Phasen ───────────────────────────────────────────────
  const timelineEl = root.querySelector<HTMLDivElement>("#timeline")!;
  function renderTimeline(): void {
    const chips = phases
      .map(
        (p) =>
          `<span class="ph-chip ${p.id === currentPhaseId ? "active" : ""}" data-ph="${p.id}">` +
          `<button data-pick="${p.id}">${p.name}</button>` +
          (canEdit && phases.length > 1 ? `<button data-delph="${p.id}" title="✕">✕</button>` : "") +
          `</span>`,
      )
      .join("");
    timelineEl.innerHTML =
      `<span class="ph-label">${t("phase.heading")}:</span>${chips}` +
      (canEdit ? `<button id="ph-add" title="${t("phase.add")}">+</button>` : "") +
      `<label class="ph-op" title="${t("phase.outOpacity")}">` +
      `<input type="range" id="ph-op" min="0" max="100" step="5" value="${outOpacity}"/>` +
      `<span id="ph-op-v">${outOpacity}%</span></label>`;

    timelineEl.querySelectorAll<HTMLButtonElement>("[data-pick]").forEach((b) =>
      b.addEventListener("click", () => {
        currentPhaseId = b.dataset.pick!;
        renderTimeline();
        void refreshMarkers();
        phaseListeners.forEach((f) => f());
      }),
    );
    timelineEl.querySelectorAll<HTMLButtonElement>("[data-delph]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm(t("phase.confirmDelete"))) return;
        await api.deletePhase(planId, b.dataset.delph!);
        const i = phases.findIndex((p) => p.id === b.dataset.delph);
        if (i >= 0) phases.splice(i, 1);
        for (const m of markers.values()) if (m.phase_id === b.dataset.delph) m.phase_id = null;
        if (currentPhaseId === b.dataset.delph) currentPhaseId = phases[0]?.id ?? "";
        renderTimeline();
        void refreshMarkers();
        phaseListeners.forEach((f) => f());
      }),
    );
    timelineEl.querySelector("#ph-add")?.addEventListener("click", async () => {
      const name = prompt(t("phase.namePrompt"), `Phase ${phases.length}`);
      if (!name) return;
      const p = await api.createPhase(planId, name);
      phases.push({ ...p, notes: p.notes ?? "" });
      currentPhaseId = p.id;
      renderTimeline();
      void refreshMarkers();
      phaseListeners.forEach((f) => f());
    });
    const op = timelineEl.querySelector<HTMLInputElement>("#ph-op")!;
    const opv = timelineEl.querySelector<HTMLSpanElement>("#ph-op-v")!;
    op.addEventListener("input", () => {
      outOpacity = Number(op.value);
      opv.textContent = `${outOpacity}%`;
      localStorage.setItem("sidc_phaseopacity", String(outOpacity));
      void refreshMarkers();
    });
  }
  renderTimeline();

  // ── Phasen-Notizen: frei verschiebbares Fenster mit Reiter je Phase ────
  const notesWin = document.createElement("div");
  notesWin.className = "notes-win";
  notesWin.hidden = true;
  notesWin.innerHTML = `
    <div class="notes-head"><span>${t("notes.title")}</span><button class="notes-x">✕</button></div>
    <div class="notes-tabs"></div>
    <div class="notes-split">
      <textarea class="notes-edit" placeholder="${t("notes.hint")}" ${canEdit ? "" : "readonly"}></textarea>
      <div class="notes-view"></div>
    </div>`;
  root.appendChild(notesWin);
  {
    const posRaw = localStorage.getItem("sidc_noteswin");
    const pos = posRaw ? JSON.parse(posRaw) : { x: window.innerWidth - 380, y: 90 };
    notesWin.style.left = `${Math.max(0, pos.x)}px`;
    notesWin.style.top = `${Math.max(0, pos.y)}px`;
  }
  const nTabs = notesWin.querySelector<HTMLDivElement>(".notes-tabs")!;
  const nEdit = notesWin.querySelector<HTMLTextAreaElement>(".notes-edit")!;
  const nView = notesWin.querySelector<HTMLDivElement>(".notes-view")!;
  let notesTabId = currentPhaseId;
  let saveTimer = 0;

  const flushNotes = () => {
    const ph = phases.find((p) => p.id === notesTabId);
    if (!ph || !canEdit) return;
    if (ph.notes === nEdit.value) return;
    ph.notes = nEdit.value;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      void api.updatePhaseNotes(planId, ph.id, ph.notes).catch(() => {});
    }, 600);
  };
  const paintNotes = () => {
    const ph = phases.find((p) => p.id === notesTabId) ?? phases[0];
    if (!ph) return;
    notesTabId = ph.id;
    nTabs.innerHTML = phases
      .map((p) => `<button data-nt="${p.id}" class="${p.id === notesTabId ? "active" : ""}">${p.name}</button>`)
      .join("");
    nTabs.querySelectorAll<HTMLButtonElement>("[data-nt]").forEach((b) =>
      b.addEventListener("click", () => {
        flushNotes();
        notesTabId = b.dataset.nt!;
        paintNotes();
      }),
    );
    nEdit.value = ph.notes ?? "";
    nView.innerHTML = renderMarkdown(ph.notes ?? "");
  };
  nEdit.addEventListener("input", () => {
    flushNotes();
    nView.innerHTML = renderMarkdown(nEdit.value);
  });
  nEdit.addEventListener("blur", flushNotes);
  // Phasenwechsel → Reiter dieser Phase aktiv machen
  phaseListeners.push(() => {
    flushNotes();
    notesTabId = currentPhaseId;
    paintNotes();
  });
  notesWin.querySelector(".notes-x")!.addEventListener("click", () => (notesWin.hidden = true));
  root.querySelector("#notesBtn")!.addEventListener("click", () => {
    notesWin.hidden = !notesWin.hidden;
    if (!notesWin.hidden) paintNotes();
  });
  // Ziehen am Kopf
  {
    const head = notesWin.querySelector<HTMLDivElement>(".notes-head")!;
    let dx = 0;
    let dy = 0;
    const onMove = (e: MouseEvent) => {
      notesWin.style.left = `${e.clientX - dx}px`;
      notesWin.style.top = `${e.clientY - dy}px`;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      localStorage.setItem(
        "sidc_noteswin",
        JSON.stringify({ x: parseInt(notesWin.style.left), y: parseInt(notesWin.style.top) }),
      );
    };
    head.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest(".notes-x")) return;
      dx = e.clientX - notesWin.offsetLeft;
      dy = e.clientY - notesWin.offsetTop;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  // ── Ebenen: Basiskarte-Layer + Topo-Vektor + Map-Locations ─────────────
  interface LocGroup {
    key: string;
    label: string;
    items: {
      x: number;
      y: number;
      lon: number;
      lat: number;
      names: Record<string, string>;
      color: number[];
      bold: boolean;
      italic: boolean;
      size: number;
    }[];
  }
  let locData: { langs: string[]; groups: LocGroup[] } | null = null;
  let mapLang = "en_us";
  const groupVisible = new Map<string, boolean>();
  const baseLayerVisible: Record<string, boolean> = { sat: true, grid: true, contours: false, peaks: false };
  // Logische Overlay-Layer -> tatsaechliche MapLibre-Layer-IDs
  const overlayLayers: Record<string, string[]> = {
    contours: ["contours-line", "contours-label"],
    peaks: ["peaks-sym"],
  };
  let hasContours = false;
  let hasPeaks = false;

  // Deckkraft je Ebene (0..1), pro Browser gespeichert.
  const layerOpacity: Record<string, number> = (() => {
    try {
      return { ...JSON.parse(localStorage.getItem("sidc_layeropacity") || "{}") };
    } catch {
      return {};
    }
  })();
  const opac = (name: string): number => (layerOpacity[name] ?? 1);

  function setLayerOpacity(name: string, f: number): void {
    layerOpacity[name] = f;
    try {
      localStorage.setItem("sidc_layeropacity", JSON.stringify(layerOpacity));
    } catch {
      /* ignore */
    }
    const has = (id: string) => !!map.getLayer(id);
    if ((name === "sat" || name === "grid") && has(name)) {
      map.setPaintProperty(name, "raster-opacity", f);
    } else if (name === "contours") {
      if (has("contours-line"))
        map.setPaintProperty("contours-line", "line-opacity", [
          "*",
          f,
          ["case", ["get", "bold"], 0.85, 0.5],
        ]);
      if (has("contours-label")) map.setPaintProperty("contours-label", "text-opacity", f);
    } else if (name === "peaks") {
      if (has("peaks-sym")) map.setPaintProperty("peaks-sym", "text-opacity", f);
    } else if (name === "locations") {
      if (has("locations-dots")) {
        map.setPaintProperty("locations-dots", "circle-opacity", f);
        map.setPaintProperty("locations-dots", "circle-stroke-opacity", f);
      }
      if (has("locations-labels")) map.setPaintProperty("locations-labels", "text-opacity", f);
    }
  }

  const locFC = (): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: (locData?.groups ?? [])
      .filter((g) => groupVisible.get(g.key) !== false)
      .flatMap((g) =>
        g.items.map((it) => ({
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: [it.lon, it.lat] },
          properties: {
            label: it.names[mapLang] || it.names.en_us || Object.values(it.names)[0] || "",
            color: `rgb(${Math.round(it.color[0] * 255)},${Math.round(it.color[1] * 255)},${Math.round(it.color[2] * 255)})`,
            size: 11 + (it.size - 0.75) * 6,
          },
        })),
      ),
  });
  const refreshLoc = () => (map.getSource("locations") as GeoJSONSource)?.setData(locFC());

  map.on("load", async () => {
    // Map-Locations  (Topo/Straßen-Overlay ist derzeit deaktiviert)
    try {
      const r = await fetch(`/api/maps/${mapId}/locations.json`, { credentials: "include" });
      if (r.ok) {
        locData = await r.json();
        mapLang =
          locData!.langs.find((l) => l.startsWith(navigator.language.slice(0, 2))) ??
          (locData!.langs.includes("en_us") ? "en_us" : locData!.langs[0]);
        for (const g of locData!.groups) groupVisible.set(g.key, true);
        map.addSource("locations", { type: "geojson", data: locFC() });
        // Punkt + Beschriftung getrennt: der Punkt bleibt immer sichtbar, auch wenn
        // sich Labels bei kleinem Zoom gegenseitig verdrängen.
        map.addLayer({
          id: "locations-dots",
          type: "circle",
          source: "locations",
          paint: {
            "circle-radius": 3,
            "circle-color": ["get", "color"],
            "circle-stroke-color": "#000",
            "circle-stroke-width": 1,
          },
        });
        map.addLayer({
          id: "locations-labels",
          type: "symbol",
          source: "locations",
          layout: {
            "text-field": ["get", "label"],
            "text-size": ["get", "size"],
            "text-anchor": "top",
            "text-offset": [0, 0.5],
            "text-allow-overlap": false,
            "text-optional": true,
          },
          paint: { "text-color": ["get", "color"], "text-halo-color": "#000", "text-halo-width": 1.6 },
        });
      }
    } catch {
      /* keine Locations */
    }
    await addTerrainOverlays();
    for (const n of ["sat", "grid", "contours", "peaks", "locations"])
      if (layerOpacity[n] != null) setLayerOpacity(n, layerOpacity[n]);
    buildLayersPanel();
    buildMapLangSelector();
  });

  // Hoehenlinien + dominante Hoehenpunkte (aus dem Mappack, pipeline/terrain_features.py).
  // Standardmaessig aus — Umschalten ueber das Ebenen-Panel.
  async function addTerrainOverlays(): Promise<void> {
    const beforeId = map.getLayer("strokes") ? "strokes" : undefined;
    try {
      const r = await fetch(`/api/maps/${mapId}/contours.geojson`, { credentials: "include" });
      if (r.ok) {
        map.addSource("contours", { type: "geojson", data: await r.json() });
        map.addLayer(
          {
            id: "contours-line",
            type: "line",
            source: "contours",
            layout: { visibility: "none", "line-join": "round" },
            paint: {
              "line-color": "#8a6d3b",
              "line-opacity": ["case", ["get", "bold"], 0.75, 0.45],
              "line-width": ["interpolate", ["linear"], ["zoom"], 11, ["case", ["get", "bold"], 0.9, 0.4], 16, ["case", ["get", "bold"], 2.2, 1.0]],
            },
          },
          beforeId,
        );
        map.addLayer(
          {
            id: "contours-label",
            type: "symbol",
            source: "contours",
            filter: ["==", ["get", "bold"], true],
            minzoom: 13,
            layout: {
              visibility: "none",
              "symbol-placement": "line",
              "text-field": ["concat", ["to-string", ["get", "elev"]], " m"],
              "text-size": 10,
              "symbol-spacing": 320,
              "text-max-angle": 25,
            },
            paint: { "text-color": "#6b5327", "text-halo-color": "#f5efe2", "text-halo-width": 1.4 },
          },
          beforeId,
        );
        hasContours = true;
      }
    } catch {
      /* keine Hoehenlinien */
    }
    try {
      const r = await fetch(`/api/maps/${mapId}/peaks.geojson`, { credentials: "include" });
      if (r.ok) {
        map.addSource("peaks", { type: "geojson", data: await r.json() });
        map.addLayer(
          {
            id: "peaks-sym",
            type: "symbol",
            source: "peaks",
            layout: {
              visibility: "none",
              "text-field": ["concat", "▲ ", ["to-string", ["get", "elev"]], " m"],
              "text-size": ["match", ["get", "type"], "dominant_peak", 13, 11],
              "text-anchor": "top",
              "text-offset": [0, 0.4],
              "text-allow-overlap": false,
              "text-optional": true,
            },
            paint: {
              "text-color": ["match", ["get", "type"], "dominant_peak", "#7a2e12", "ridge", "#5a4a2a", "#4a3a1a"],
              "text-halo-color": "#f5efe2",
              "text-halo-width": 1.6,
            },
          },
          beforeId,
        );
        hasPeaks = true;
      }
    } catch {
      /* keine Hoehenpunkte */
    }
  }

  const layersPanel = root.querySelector<HTMLDivElement>("#layersPanel")!;
  root.querySelector("#layersBtn")!.addEventListener("click", () => (layersPanel.hidden = !layersPanel.hidden));

  function buildLayersPanel(): void {
    const rows: string[] = [`<div class="fav-head">${t('layers.heading')}</div>`];
    // name -> (Anzeigename, Deckkraft-Regler?)
    const entries: [string, string, boolean][] = [];
    for (const ly of ["sat", "grid", "terrain"])
      if (map.getLayer(ly)) entries.push([ly, ly, ly !== "terrain"]);
    if (hasContours) entries.push(["contours", t("layers.contours"), true]);
    if (hasPeaks) entries.push(["peaks", t("layers.peaks"), true]);

    for (const [name, label, hasSlider] of entries) {
      const on = baseLayerVisible[name] !== false;
      const slider = hasSlider
        ? `<input type="range" min="0" max="100" step="5" value="${Math.round(opac(name) * 100)}" data-op="${name}" title="${t("layers.opacity")}"/>`
        : "";
      rows.push(
        `<div class="layer-row"><label><input type="checkbox" data-base="${name}" ${on ? "checked" : ""}/> ${label}</label>${slider}</div>`,
      );
    }

    if (locData) {
      rows.push(`<div class="fav-head">${t('layers.places')}</div>`);
      rows.push(
        `<div class="layer-row"><label>${t("layers.opacity")}</label><input type="range" min="0" max="100" step="5" value="${Math.round(opac("locations") * 100)}" data-op="locations" title="${t("layers.opacity")}"/></div>`,
      );
      for (const g of locData.groups) {
        rows.push(
          `<label><input type="checkbox" data-group="${g.key}" checked/> ${g.label} <span class="muted">${g.items.length}</span></label>`,
        );
      }
    }
    layersPanel.innerHTML = rows.join("");
    layersPanel.querySelectorAll<HTMLInputElement>("[data-base]").forEach((cb) =>
      cb.addEventListener("change", () => {
        const name = cb.dataset.base!;
        baseLayerVisible[name] = cb.checked;
        const targets = overlayLayers[name] ?? [name];
        for (const id of targets)
          if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", cb.checked ? "visible" : "none");
        if (name === "grid") updateGrid();
      }),
    );
    layersPanel.querySelectorAll<HTMLInputElement>("[data-op]").forEach((sl) =>
      sl.addEventListener("input", () => setLayerOpacity(sl.dataset.op!, +sl.value / 100)),
    );
    layersPanel.querySelectorAll<HTMLInputElement>("[data-group]").forEach((cb) =>
      cb.addEventListener("change", () => {
        groupVisible.set(cb.dataset.group!, cb.checked);
        refreshLoc();
      }),
    );
  }

  function buildMapLangSelector(): void {
    const sel = root.querySelector<HTMLSelectElement>("#maplang")!;
    if (!locData) {
      sel.hidden = true;
      return;
    }
    sel.innerHTML = locData.langs.map((l) => `<option value="${l}" ${l === mapLang ? "selected" : ""}>${l}</option>`).join("");
    sel.addEventListener("change", () => {
      mapLang = sel.value;
      refreshLoc();
    });
  }

  // ── Koordinaten-Grid (wie ATAKmaps) ───────────────────────────────────
  // Die Linien selbst kommen aus dem gebackenen 'grid'-Raster-Layer (style.json),
  // das Canvas zeichnet nur noch die bildschirmrand-verankerte Beschriftung.
  const gridCanvas = root.querySelector<HTMLCanvasElement>("#gridCanvas")!;
  const gctx = gridCanvas.getContext("2d")!;
  const GRID_LEVELS = [10, 100, 1000, 10000];
  const GRID_MIN_PX = 55;
  const GRID_MAX_LINES = 400;
  type GridLine = { axis: "x" | "y"; value: number; major: boolean; p0: [number, number]; p1: [number, number] };
  let gridLines: GridLine[] = [];

  const gridOn = () => baseLayerVisible.grid !== false;

  function resizeGridCanvas(): void {
    const r = map.getContainer().getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    gridCanvas.width = Math.round(r.width * dpr);
    gridCanvas.height = Math.round(r.height * dpr);
    gridCanvas.style.width = r.width + "px";
    gridCanvas.style.height = r.height + "px";
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function clipSeg(
    p0: [number, number],
    p1: [number, number],
    w: number,
    h: number,
  ): [[number, number], [number, number]] | null {
    let t0 = 0;
    let t1 = 1;
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const checks: [number, number][] = [
      [-dx, p0[0]],
      [dx, w - p0[0]],
      [-dy, p0[1]],
      [dy, h - p0[1]],
    ];
    for (const [p, q] of checks) {
      if (p === 0) {
        if (q < 0) return null;
        continue;
      }
      const rr = q / p;
      if (p < 0) {
        if (rr > t1) return null;
        if (rr > t0) t0 = rr;
      } else {
        if (rr < t0) return null;
        if (rr < t1) t1 = rr;
      }
    }
    return [
      [p0[0] + t0 * dx, p0[1] + t0 * dy],
      [p0[0] + t1 * dx, p0[1] + t1 * dy],
    ];
  }

  function edgeOf(pt: [number, number], w: number, h: number, eps = 1.5): string | null {
    if (pt[1] <= eps) return "top";
    if (pt[1] >= h - eps) return "bottom";
    if (pt[0] <= eps) return "left";
    if (pt[0] >= w - eps) return "right";
    return null;
  }

  function drawEdgeLabel(text: string, pt: [number, number], edge: string, major: boolean): void {
    const w = gridCanvas.clientWidth;
    const h = gridCanvas.clientHeight;
    gctx.font = major ? "600 11px monospace" : "500 10px monospace";
    const tw = gctx.measureText(text).width;
    let x = pt[0];
    let y = pt[1];
    if (edge === "top") {
      y += 11;
      x = Math.min(Math.max(x, tw / 2 + 4), w - tw / 2 - 4);
    } else if (edge === "bottom") {
      y -= 8;
      x = Math.min(Math.max(x, tw / 2 + 4), w - tw / 2 - 4);
    } else if (edge === "left") {
      x += 4 + tw / 2;
      y = Math.min(Math.max(y, 12), h - 8);
    } else {
      x -= 4 + tw / 2;
      y = Math.min(Math.max(y, 12), h - 8);
    }
    gctx.textAlign = "center";
    gctx.textBaseline = "middle";
    gctx.fillStyle = "rgba(0,0,0,0.55)";
    gctx.fillRect(x - tw / 2 - 3, y - 8, tw + 6, 16);
    gctx.fillStyle = major ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.7)";
    gctx.fillText(text, x, y);
  }

  function safeGame(px: number, py: number): [number, number] | null {
    const ll = map.unproject([px, py]);
    if (!isFinite(ll.lng) || !isFinite(ll.lat)) return null;
    const g = lngLatToWorld(cal, ll.lng, ll.lat);
    return isFinite(g[0]) && isFinite(g[1]) ? g : null;
  }

  // Horizon-sicher: bei gepitchter 3D-Ansicht landen Ecken oberhalb des Horizonts
  // auf riesigen/NaN-Koordinaten — dann per Bisektion zum Zentrum den sichtbaren
  // Schnittpunkt suchen.
  function visibleGame(
    px: number,
    py: number,
    center: [number, number, number, number],
    maxDist: number,
  ): [number, number] {
    const tooFar = (p: [number, number] | null) =>
      !p || Math.hypot(p[0] - center[0], p[1] - center[1]) > maxDist;
    const direct = safeGame(px, py);
    if (!tooFar(direct)) return direct as [number, number];
    let lo = 0;
    let hi = 1;
    let best: [number, number] = [center[0], center[1]];
    for (let i = 0; i < 12; i++) {
      const tt = (lo + hi) / 2;
      const p = safeGame(center[2] + (px - center[2]) * tt, center[3] + (py - center[3]) * tt);
      if (!tooFar(p)) {
        best = p as [number, number];
        lo = tt;
      } else {
        hi = tt;
      }
    }
    return best;
  }

  function updateGrid(): void {
    if (map.getLayer("grid")) {
      map.setLayoutProperty("grid", "visibility", gridOn() ? "visible" : "none");
    }
    if (!cal || !gridOn()) {
      gridLines = [];
      drawGridLabels();
      return;
    }
    const w = map.getContainer().clientWidth;
    const h = map.getContainer().clientHeight;
    if (!w || !h) return;

    const c0 = map.unproject([w / 2, h / 2]);
    const c1 = map.unproject([w / 2 + 1, h / 2]);
    const g0 = lngLatToWorld(cal, c0.lng, c0.lat);
    const g1 = lngLatToWorld(cal, c1.lng, c1.lat);
    const mpp = Math.hypot(g1[0] - g0[0], g1[1] - g0[1]) || 1;

    let mi = GRID_LEVELS.findIndex((lvl) => lvl / mpp >= GRID_MIN_PX);
    if (mi === -1) mi = GRID_LEVELS.length - 1;
    const minor = GRID_LEVELS[mi];
    const major = GRID_LEVELS[Math.min(mi + 1, GRID_LEVELS.length - 1)];
    const labelMinor = minor >= 100;

    const center: [number, number, number, number] = [g0[0], g0[1], w / 2, h / 2];
    const maxDist = Math.max(minor * 200, 5000);
    const corners = ([[0, 0], [w, 0], [0, h], [w, h]] as [number, number][]).map(([px, py]) =>
      visibleGame(px, py, center, maxDist),
    );
    const m2 = minor * 2;
    const minX = Math.min(...corners.map((c) => c[0])) - m2;
    const maxX = Math.max(...corners.map((c) => c[0])) + m2;
    const minY = Math.min(...corners.map((c) => c[1])) - m2;
    const maxY = Math.max(...corners.map((c) => c[1])) + m2;
    if (minX > maxX || minY > maxY) {
      gridLines = [];
      drawGridLabels();
      return;
    }

    const lines: GridLine[] = [];
    const collect = (axis: "x" | "y", spacing: number, isMajor: boolean) => {
      const lo = axis === "x" ? minX : minY;
      const hi = axis === "x" ? maxX : maxY;
      const tLo = axis === "x" ? minY : minX;
      const tHi = axis === "x" ? maxY : maxX;
      let drawn = 0;
      for (let v = Math.floor(lo / spacing) * spacing; v <= hi; v += spacing) {
        if (++drawn > GRID_MAX_LINES) break;
        if (!isMajor && spacing !== major && Math.abs(v % major) < 1e-6) continue;
        if (!isMajor && !labelMinor) continue;
        const a = axis === "x" ? worldToLngLat(cal, v, tLo) : worldToLngLat(cal, tLo, v);
        const b = axis === "x" ? worldToLngLat(cal, v, tHi) : worldToLngLat(cal, tHi, v);
        lines.push({ axis, value: v, major: isMajor, p0: a, p1: b });
      }
    };
    if (minor !== major) {
      collect("x", minor, false);
      collect("y", minor, false);
    }
    collect("x", major, true);
    collect("y", major, true);
    gridLines = lines;
    drawGridLabels();
  }

  function drawGridLabels(): void {
    const w = gridCanvas.clientWidth;
    const h = gridCanvas.clientHeight;
    if (!w || !h) return;
    gctx.clearRect(0, 0, w, h);
    if (!gridOn() || !gridLines.length) return;
    for (const line of gridLines) {
      const s0 = map.project(line.p0);
      const s1 = map.project(line.p1);
      const seg = clipSeg([s0.x, s0.y], [s1.x, s1.y], w, h);
      if (!seg) continue;
      const label = (line.axis === "x" ? "X " : "Y ") + Math.round(line.value);
      for (const pt of seg) {
        const edge = edgeOf(pt, w, h);
        if (edge) drawEdgeLabel(label, pt, edge, line.major);
      }
    }
  }

  let gridRaf = 0;
  const scheduleGridLabels = () => {
    if (gridRaf) return;
    gridRaf = requestAnimationFrame(() => {
      gridRaf = 0;
      drawGridLabels();
    });
  };
  resizeGridCanvas();
  map.on("moveend", updateGrid);
  map.on("move", scheduleGridLabels);
  map.on("resize", () => {
    resizeGridCanvas();
    updateGrid();
  });
  window.addEventListener("resize", () => {
    resizeGridCanvas();
    updateGrid();
  });
  map.on("style.load", updateGrid);
  map.once("idle", updateGrid);

  if (!canEdit) return;

  // ── Werkzeugleiste ────────────────────────────────────────────────────
  const toolbar = root.querySelector<HTMLDivElement>("#toolbar")!;
  const lineStylePanel = root.querySelector<HTMLDivElement>("#lineStyle")!;
  let linePts: [number, number][] = [];
  let chainGroup: number | null = null;
  let chainIndex = 0;
  // Marker-Workflow wie im ATAK: erst Position auf der Karte klicken, dann öffnet
  // sich der Wizard. awaitingPos = warte auf den Positions-Klick.
  let awaitingPos = false;
  let pendingPos: [number, number] | null = null;
  let measurePts: [number, number][] = [];

  const refreshLineDraft = () =>
    (map.getSource("linedraft") as GeoJSONSource)?.setData(lineDraftFC(linePts));

  const fmtDist = (mtr: number) => (mtr < 1000 ? `${Math.round(mtr)} m` : `${(mtr / 1000).toFixed(2)} km`);
  const redrawMeasure = () => {
    const src = map.getSource("measure") as GeoJSONSource | undefined;
    if (!src) return;
    const feats: GeoJSON.Feature[] = measurePts.map((p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: p },
      properties: {},
    }));
    if (measurePts.length === 2) {
      const [a, b] = measurePts;
      const [ax, ay] = lngLatToWorld(cal, a[0], a[1]);
      const [bx, by] = lngLatToWorld(cal, b[0], b[1]);
      const dist = Math.hypot(bx - ax, by - ay);
      feats.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [a, b] },
        properties: { kind: "line" },
      });
      feats.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] },
        properties: { kind: "label", label: fmtDist(dist) },
      });
    }
    src.setData({ type: "FeatureCollection", features: feats });
  };

  const setMode = (m: Mode) => {
    mode = m;
    toolbar.querySelectorAll("[data-mode]").forEach((b) =>
      b.classList.toggle("active", (b as HTMLElement).dataset.mode === m),
    );
    map.getCanvas().style.cursor =
      m === "place" || m === "line" || m === "measure"
        ? "crosshair"
        : m === "erase"
          ? "not-allowed"
          : m === "markermove"
            ? "move"
            : "";
    // Zeigen + Linie + Radierer + Messen + Marker-Verschieben: Karte fixieren
    if (m === "point" || m === "line" || m === "erase" || m === "measure" || m === "markermove") {
      map.dragPan.disable();
      map.dragRotate.disable();
    } else {
      map.dragPan.enable();
      map.dragRotate.enable();
    }
    if (m === "line") map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
    lineStylePanel.hidden = m !== "line";
    if (m !== "line") {
      linePts = [];
      refreshLineDraft();
    }
    if (m !== "measure") {
      measurePts = [];
      redrawMeasure();
    }
    if (m !== "place") {
      pending = null;
      chainGroup = null;
      awaitingPos = false;
      pendingPos = null;
    }
  };
  toolbar.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => setMode(b.dataset.mode as Mode)),
  );

  function placeMarker(pos: [number, number], tpl: MarkerTemplate): void {
    const data: Record<string, unknown> = {
      sidc: tpl.sidc,
      world_x: pos[0],
      world_y: pos[1],
      unit_text: tpl.unit_text,
      ai_text: tpl.ai_text,
      channel: tpl.channel || myChannel,
      locked: tpl.locked,
      timestamp_visible: tpl.timestamp_visible,
      rotation_degrees: tpl.rotation_degrees,
      phase_id: currentPhaseId || null,
    };
    if (chainGroup != null) {
      data.linked_group_id = chainGroup;
      data.point_index = chainIndex;
      if (chainIndex === 0) {
        data.line_color = lineColor;
        data.line_width = lineWidth;
      }
      chainIndex++;
    }
    socket.send({ type: "marker.create", cid: cid(), data });
  }

  root.querySelector("#tool-marker")!.addEventListener("click", () => {
    pending = null;
    pendingPos = null;
    setMode("place"); // Karte fixiert, Fadenkreuz — jetzt Position klicken
    awaitingPos = true;
  });

  // Linien-Stil-Panel
  const lcBox = root.querySelector<HTMLDivElement>("#lc")!;
  const drawColors = () =>
    (lcBox.innerHTML = lineColors
      .map(
        (c) =>
          `<button data-pc="${c.packedColor}" title="${c.name}" style="background:rgb(${c.red},${c.green},${c.blue})" class="${
            c.packedColor === lineColor ? "active" : ""
          }"></button>`,
      )
      .join(""));
  drawColors();
  lcBox.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("[data-pc]") as HTMLElement | null;
    if (!b) return;
    lineColor = Number(b.dataset.pc);
    drawColors();
  });
  root.querySelector<HTMLSelectElement>("#lw")!.addEventListener("change", (e) => {
    lineWidth = Number((e.target as HTMLSelectElement).value);
  });
  const finishLine = () => {
    if (linePts.length >= 2) {
      socket.send({
        type: "stroke.commit",
        cid: cid(),
        data: { kind: "phaseline", points: linePts, color: lineColor, width: lineWidth },
      });
    }
    linePts = [];
    refreshLineDraft();
  };
  root.querySelector("#lineFinish")!.addEventListener("click", finishLine);
  root.querySelector("#lineCancel")!.addEventListener("click", () => {
    linePts = [];
    refreshLineDraft();
  });

  function applyCaps(): void {
    const tb = root.querySelector("#toolbar");
    if (!tb) return;
    tb.querySelector<HTMLButtonElement>('[data-mode="line"]')?.toggleAttribute("disabled", !caps.draw);
    tb.querySelector<HTMLButtonElement>('[data-mode="markermove"]')?.toggleAttribute("disabled", !caps.move);
    tb.querySelector<HTMLButtonElement>('[data-mode="erase"]')?.toggleAttribute("disabled", !caps.delete);
    tb.querySelector<HTMLButtonElement>("#tool-marker")?.toggleAttribute("disabled", !caps.place);
    tb.querySelector<HTMLButtonElement>("#tool-fav")?.toggleAttribute("disabled", !caps.place);
  }
  applyCaps();

  // ── Favoriten ─────────────────────────────────────────────────────────
  const favPanel = root.querySelector<HTMLDivElement>("#favPanel")!;
  let favs = await api.favorites();
  const renderFavs = () => {
    favPanel.innerHTML =
      `<div class="fav-head">${t("fav.heading")}</div>` +
      (favs.length
        ? favs
            .map(
              (f) => `<div class="fav" data-fav="${f.id}">
                <img src="${iconSrc(f.sidc)}" width="24" height="24" onerror="this.style.visibility='hidden'"/>
                <span>${f.label}</span><button data-delfav="${f.id}">✕</button></div>`,
            )
            .join("")
        : `<div class="muted">${t("fav.hint")}</div>`);
    favPanel.querySelectorAll<HTMLElement>("[data-fav]").forEach((el) =>
      el.addEventListener("click", (ev) => {
        if ((ev.target as HTMLElement).dataset.delfav) return;
        const f = favs.find((x) => x.id === el.dataset.fav)!;
        setMode("place");
        awaitingPos = false; // Favorit direkt per Klick platzieren
        chainGroup = f.is_multipoint ? Math.floor(Math.random() * 1e9) : null;
        chainIndex = 0;
        pending = {
          sidc: f.sidc,
          unit_text: f.unit_text,
          ai_text: f.ai_text,
          channel: myChannel,
          locked: false,
          timestamp_visible: true,
          rotation_degrees: f.rotation_degrees,
          is_multipoint: f.is_multipoint,
          max_line_points: f.max_line_points,
        };
      }),
    );
    favPanel.querySelectorAll<HTMLButtonElement>("[data-delfav]").forEach((b) =>
      b.addEventListener("click", async () => {
        await api.deleteFavorite(b.dataset.delfav!);
        favs = await api.favorites();
        renderFavs();
      }),
    );
  };
  renderFavs();
  root.querySelector("#tool-fav")!.addEventListener("click", () => (favPanel.hidden = !favPanel.hidden));

  // ── Karten-Interaktion ────────────────────────────────────────────────
  const redrawMarkersOnly = () => {
    (map.getSource("markers") as GeoJSONSource)?.setData(markerFC());
    (map.getSource("chains") as GeoJSONSource)?.setData(chainFC());
    refreshDir();
  };

  let suppressClick = false;
  const onMarkerClick = (e: maplibregl.MapLayerMouseEvent) => {
    if (dragId || suppressClick) return; // gerade verschoben
    e.preventDefault();
    const id = e.features?.[0]?.properties?.id as string;
    const m = markers.get(id);
    if (!m) return;
    if (mode === "erase") {
      if (caps.delete) socket.send({ type: "marker.delete", id: m.id });
    } else if (mode === "move" || mode === "markermove") {
      openEditPanel(m);
    }
  };
  map.on("click", "marker-icon", onMarkerClick);
  map.on("click", "marker-dot", onMarkerClick); // Marker ohne PNG-Icon klickbar halten

  // Marker ziehen: im Modus "markermove" (linke Taste) ODER im Karten-Modus mit
  // gehaltener mittlerer Maustaste.
  let dragId: string | null = null;
  const onMarkerMouseDown = (e: maplibregl.MapLayerMouseEvent) => {
    const midBtn = e.originalEvent.button === 1;
    const wantDrag = caps.move && (mode === "markermove" || (mode === "move" && midBtn));
    if (!wantDrag) return;
    const id = e.features?.[0]?.properties?.id as string;
    const m = id ? markers.get(id) : undefined;
    if (!m || m.locked) return;
    e.preventDefault();
    e.originalEvent.preventDefault(); // Mittelklick-Autoscroll unterdrücken
    dragId = id;
    map.dragPan.disable();
    map.getCanvas().style.cursor = "grabbing";
    const onMove = (ev: maplibregl.MapMouseEvent) => {
      const mm = markers.get(dragId!);
      if (!mm) return;
      mm.world_x = ev.lngLat.lng;
      mm.world_y = ev.lngLat.lat;
      redrawMarkersOnly();
    };
    const onUp = (ev: maplibregl.MapMouseEvent) => {
      map.off("mousemove", onMove);
      const finished = dragId;
      dragId = null;
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 0);
      if (mode === "move") map.dragPan.enable();
      map.getCanvas().style.cursor = mode === "markermove" ? "move" : "";
      if (finished) {
        socket.send({ type: "marker.move", id: finished, world_x: ev.lngLat.lng, world_y: ev.lngLat.lat });
      }
    };
    map.on("mousemove", onMove);
    map.once("mouseup", onUp);
  };
  map.on("mousedown", "marker-icon", onMarkerMouseDown);
  map.on("mousedown", "marker-dot", onMarkerMouseDown);
  // Mittelklick auf dem Canvas nie als Browser-Autoscroll interpretieren
  map.getCanvas().addEventListener("mousedown", (ev) => {
    if (ev.button === 1) ev.preventDefault();
  });

  map.on("dblclick", (e) => {
    if (mode === "line") {
      e.preventDefault();
      finishLine();
    }
  });

  // Rechtsklick beendet: gezeichnete Linie ODER eine laufende Marker-Linie (Multipoint)
  map.on("contextmenu", (e) => {
    if (mode === "line" && linePts.length) {
      e.preventDefault();
      finishLine();
    } else if (mode === "place" && chainGroup != null && chainIndex > 0) {
      e.preventDefault();
      setMode("move");
    }
  });

  map.on("click", (e) => {
    if ((e as { defaultPrevented?: boolean }).defaultPrevented) return;

    if (mode === "erase") {
      // Linien haben eine schmale Trefferfläche — mit etwas Toleranz suchen.
      const pad = 6;
      const hits = map.queryRenderedFeatures(
        [
          [e.point.x - pad, e.point.y - pad],
          [e.point.x + pad, e.point.y + pad],
        ],
        { layers: ["strokes"] },
      );
      const id = hits[0]?.properties?.id as string | undefined;
      if (id && caps.draw) socket.send({ type: "stroke.delete", id });
      return;
    }

    if (mode === "line") {
      linePts.push([e.lngLat.lng, e.lngLat.lat]);
      refreshLineDraft();
      return;
    }

    if (mode === "measure") {
      if (measurePts.length >= 2) measurePts = []; // dritter Klick: löschen
      else measurePts.push([e.lngLat.lng, e.lngLat.lat]);
      redrawMeasure();
      return;
    }

    if (mode === "place") {
      const pos: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      if (awaitingPos) {
        awaitingPos = false;
        pendingPos = pos;
        openWizard(root, (tpl) => {
          pending = tpl;
          chainGroup = tpl.is_multipoint ? Math.floor(Math.random() * 1e9) : null;
          chainIndex = 0;
          placeMarker(pendingPos ?? pos, tpl); // sofort an der geklickten Position
          if (!tpl.is_multipoint) setMode("move");
        });
        return;
      }
      if (pending) {
        placeMarker(pos, pending);
        const done =
          !pending.is_multipoint || (pending.max_line_points > 0 && chainIndex >= pending.max_line_points);
        if (done) setMode("move");
      }
    }
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      if (mode === "line" && linePts.length) finishLine();
      else setMode("move");
    }
  });

  // ── Marker-Edit-Panel (zentriertes Fenster, Klick außerhalb schließt) ──
  function openEditPanel(m: Marker): void {
    root.querySelector("#editModal")?.remove();
    const back = document.createElement("div");
    back.className = "edit-modal";
    back.id = "editModal";
    const p = document.createElement("div");
    p.className = "edit-panel";

    // Advanced: Modifikatoren des Markers aus dem SIDC lesen + bearbeiten
    const subCat = subCatBySidc.get(m.sidc.slice(4, 6) + m.sidc.slice(10, 16));
    const modDefs = subCat && modCat ? modCat[subCat] : null;
    const MOD_KEY: Record<string, keyof SidcModifiers> = { modifier1: "m1", modifier2: "m2", modifier3: "m3", modifier4: "m4" };
    const MOD_LBL: Record<string, string> = {
      modifier1: t("wiz.modifier1"), modifier2: t("wiz.modifier2"), modifier3: t("wiz.modifier3"), modifier4: t("wiz.modifier4"),
    };
    const curMods: SidcModifiers = {
      m4: Number(m.sidc[6]) || 0,
      m3: Number(m.sidc[7]) || 0,
      m1: Number(m.sidc.slice(16, 18)) || 0,
      m2: Number(m.sidc.slice(18, 20)) || 0,
    };
    const advHtml =
      modDefs && ["modifier1", "modifier2", "modifier3", "modifier4"].some((g) => (modDefs[g] ?? []).length)
        ? `<details class="edit-adv"><summary>${t("wiz.advanced")}</summary>` +
          ["modifier1", "modifier2", "modifier3", "modifier4"]
            .filter((g) => (modDefs[g] ?? []).length)
            .map((g) => {
              const key = MOD_KEY[g];
              const cur = curMods[key] ?? 0;
              return `<label>${MOD_LBL[g]}</label><select data-mod="${key}"><option value="0">—</option>${modDefs[g]
                .map((o) => `<option value="${o.code}" ${o.code === cur ? "selected" : ""}>${o.description}</option>`)
                .join("")}</select>`;
            })
            .join("") +
          `</details>`
        : "";

    p.innerHTML = `
      <div class="fav-head"><img class="edit-ico" src="${iconSrc(m.sidc)}" width="26" height="26" onerror="this.style.visibility='hidden'"/> ${t("marker.heading")}</div>
      <label>${t("marker.unitText")}</label><input data-unit value="${m.unit_text}" />
      <label>${t("marker.aiText")}</label><input data-ai value="${m.ai_text}" />
      <label>${t("marker.iconRot")}</label><input data-rot type="number" value="${m.icon_rotation || 0}" />
      <label>${t("phase.assign")}</label>
      <select data-phase>
        <option value="">${t("phase.global")}</option>
        ${phases
          .map((ph) => `<option value="${ph.id}" ${ph.id === m.phase_id ? "selected" : ""}>${ph.name}</option>`)
          .join("")}
      </select>
      <label class="chk"><input type="checkbox" data-lock ${m.locked ? "checked" : ""}/> <span>${t("marker.locked")}</span></label>
      ${advHtml}
      <div class="row">
        <button class="primary" data-apply>${t("common.apply")}</button>
        <button data-fav>${t("fav.add")}</button>
        <button data-clone>${t("marker.clone")}</button>
        <button data-del>${t("common.delete")}</button>
      </div>`;
    back.appendChild(p);

    const readModSel = (): SidcModifiers => {
      const s: SidcModifiers = {};
      p.querySelectorAll<HTMLSelectElement>("[data-mod]").forEach((sel) => {
        const v = Number(sel.value);
        s[sel.dataset.mod as keyof SidcModifiers] = v || undefined;
      });
      return s;
    };
    const nextSidc = () => withModifiers(m.sidc, readModSel());
    p.querySelectorAll<HTMLSelectElement>("[data-mod]").forEach((sel) =>
      sel.addEventListener("change", () => {
        p.querySelector<HTMLImageElement>(".edit-ico")!.src = iconSrc(nextSidc());
      }),
    );
    root.appendChild(back);
    const close = () => back.remove();
    back.addEventListener("mousedown", (e) => {
      if (e.target === back) close();
    });
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        document.removeEventListener("keydown", onEsc);
      }
    };
    document.addEventListener("keydown", onEsc);
    p.querySelector("[data-apply]")!.addEventListener("click", () => {
      socket.send({
        type: "marker.modify",
        id: m.id,
        data: {
          unit_text: p.querySelector<HTMLInputElement>("[data-unit]")!.value,
          ai_text: p.querySelector<HTMLInputElement>("[data-ai]")!.value,
          icon_rotation: Number(p.querySelector<HTMLInputElement>("[data-rot]")!.value) || 0,
          phase_id: p.querySelector<HTMLSelectElement>("[data-phase]")!.value || null,
          ...(modDefs ? { sidc: nextSidc() } : {}),
        },
      });
      socket.send({ type: "marker.lock", id: m.id, locked: p.querySelector<HTMLInputElement>("[data-lock]")!.checked });
      close();
    });
    p.querySelector("[data-del]")!.addEventListener("click", () => {
      socket.send({ type: "marker.delete", id: m.id });
      close();
    });
    p.querySelector("[data-clone]")!.addEventListener("click", () => {
      chainGroup = null;
      setMode("place");
      awaitingPos = false;
      pending = {
        sidc: m.sidc,
        unit_text: m.unit_text,
        ai_text: m.ai_text,
        channel: m.channel,
        locked: m.locked,
        timestamp_visible: true,
        rotation_degrees: m.rotation_degrees,
        is_multipoint: false,
        max_line_points: 0,
      };
      close();
    });
    p.querySelector("[data-fav]")!.addEventListener("click", async () => {
      const label = prompt(t("fav.labelPrompt"), m.unit_text || m.sidc.slice(0, 8));
      if (!label) return;
      await api.addFavorite({
        label,
        sidc: m.sidc,
        rotation_degrees: m.rotation_degrees,
        unit_text: m.unit_text,
        ai_text: m.ai_text,
        is_multipoint: m.linked_group_id != null && m.linked_group_id >= 0,
        max_line_points: 0,
      });
      favs = await api.favorites();
      renderFavs();
      favPanel.hidden = false;
    });
  }

}

function packedToHex(packed: number): string {
  if (packed === undefined || packed === -1 || Number.isNaN(packed)) return "#ffd700";
  const n = packed & 0xffffff;
  return "#" + n.toString(16).padStart(6, "0");
}

function emptyFC(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function lineDraftFC(pts: [number, number][]): GeoJSON.FeatureCollection {
  const feats: GeoJSON.Feature[] = pts.map((p) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: p },
    properties: {},
  }));
  if (pts.length >= 2) {
    feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: pts }, properties: {} });
  }
  return { type: "FeatureCollection", features: feats };
}
