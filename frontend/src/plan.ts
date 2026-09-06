// Plan-Ansicht: Karte + Werkzeugleiste + HUD + Marker/Zeichnen/Präsenz live.
// Nähert sich der ATAKmaps-UI an (D:\Mods\ATAKmaps).
import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import { api, type Me } from "./api";
import { channelLabel, loadChannels, loadPhaseLineStyle } from "./sidc/catalog";
import { iconUrl, lngLatToWorld, niceStep, worldToLngLat, type Calibration } from "./sidc/sidc";
import { openWizard, type MarkerTemplate } from "./sidc/wizard";
import { openAclEditor } from "./acl";
import { t } from "./i18n";
import { cid, PlanSocket, type WsMessage } from "./ws";

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
type Mode = "move" | "point" | "line" | "erase" | "place";

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

  root.innerHTML = `
    <div class="topbar">
      <a href="#/">←</a>
      <strong>${snap.plan.name}</strong>
      <span class="badge">${myPlan?.level ?? "?"}</span>
      <button id="t3d">3D</button>
      <select id="chan" title="${t('map.channel')}">${(channels?.channels ?? [])
        .map((c) => `<option value="${c.name}" ${c.name === myChannel ? "selected" : ""}>${channelLabel(c)}</option>`)
        .join("")}</select>
      <div id="timeline" class="timeline"></div>
      <select id="maplang" title="${t("map.lang")}"></select>
      <button id="layersBtn" title="${t("tool.layers")}">☰</button>
      <span class="grow"></span>
      <span class="presence" id="presence"></span>
      ${myPlan?.level === "owner" ? `<button id="acl">${t("plans.shares")}</button>` : ""}
      ${canEdit ? `<button id="save">${t("plan.version")}</button>` : ""}
    </div>
    <div id="map"></div>
    ${
      canEdit
        ? `<div class="toolbar" id="toolbar">
             <button data-mode="move" class="active" title="${t("tool.move")}">✋</button>
             <button data-mode="point" title="${t("tool.point")}">👉</button>
             <button data-mode="line" title="${t("tool.line")}">📏</button>
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
    transformRequest: (url) =>
      url.startsWith("/") || url.startsWith(location.origin) ? { url, credentials: "include" } : { url },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

  const loadedIcons = new Set<string>();
  async function ensureIcon(sidc: string): Promise<void> {
    if (loadedIcons.has(sidc) || map.hasImage(sidc)) return;
    loadedIcons.add(sidc);
    try {
      const img = await map.loadImage(iconUrl(sidc));
      if (!map.hasImage(sidc)) map.addImage(sidc, img.data);
    } catch {
      /* fehlendes Icon: Symbol-Layer zeigt dann nichts */
    }
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
      },
    })),
  });
  const strokeFC = (): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: [...strokes.values()].map((s) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: s.points },
      properties: { color: packedToHex(s.color), width: s.width > 0 ? s.width : 2 },
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

    map.addSource("markers", { type: "geojson", data: markerFC() });
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
        "icon-opacity": ["case", ["get", "locked"], 0.6, 1],
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
  });

  const refreshMarkers = async () => {
    await Promise.all([...new Set([...markers.values()].map((m) => m.sidc))].map(ensureIcon));
    (map.getSource("markers") as GeoJSONSource)?.setData(markerFC());
    (map.getSource("chains") as GeoJSONSource)?.setData(chainFC());
  };
  const refreshStrokes = () => (map.getSource("strokes") as GeoJSONSource)?.setData(strokeFC());
  const refreshPeers = () => (map.getSource("peers") as GeoJSONSource)?.setData(peerFC());

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
      if (el != null) h = `${el.toFixed(0)} m`;
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
    if (is3D && map.getSource("terrain-dem")) {
      map.setTerrain({ source: "terrain-dem", exaggeration: 1.5 });
      map.easeTo({ pitch: 60, duration: 700 });
    } else {
      map.setTerrain(null);
      map.easeTo({ pitch: 0, bearing: 0, duration: 700 });
    }
  });

  // ── Channel ───────────────────────────────────────────────────────────
  root.querySelector<HTMLSelectElement>("#chan")!.addEventListener("change", (e) => {
    myChannel = (e.target as HTMLSelectElement).value;
  });

  root.querySelector("#acl")?.addEventListener("click", () => openAclEditor(planId, snap.plan.name));

  // ── Ebenen: Basiskarte-Layer + Topo-Vektor + Map-Locations ─────────────
  interface LocGroup {
    key: string;
    label: string;
    items: { x: number; y: number; names: Record<string, string>; color: number[]; bold: boolean; italic: boolean; size: number }[];
  }
  let locData: { langs: string[]; groups: LocGroup[] } | null = null;
  let mapLang = "en_us";
  const groupVisible = new Map<string, boolean>();
  const baseLayerVisible: Record<string, boolean> = { sat: true, grid: true };

  const locFC = (): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: (locData?.groups ?? [])
      .filter((g) => groupVisible.get(g.key) !== false)
      .flatMap((g) =>
        g.items.map((it) => ({
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: [it.x, it.y] },
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
    // Topo-Vektor
    try {
      const r = await fetch(`/api/maps/${mapId}/topo.geojson`, { credentials: "include" });
      if (r.ok) {
        map.addSource("topo", { type: "geojson", data: await r.json() });
        map.addLayer(
          {
            id: "topo",
            type: "line",
            source: "topo",
            layout: { visibility: "none", "line-cap": "round" },
            paint: { "line-color": "#d8c37a", "line-width": 1.4, "line-opacity": 0.85 },
          },
          "strokes",
        );
      }
    } catch {
      /* kein Topo */
    }
    // Map-Locations
    try {
      const r = await fetch(`/api/maps/${mapId}/locations.json`, { credentials: "include" });
      if (r.ok) {
        locData = await r.json();
        mapLang =
          locData!.langs.find((l) => l.startsWith(navigator.language.slice(0, 2))) ??
          (locData!.langs.includes("en_us") ? "en_us" : locData!.langs[0]);
        for (const g of locData!.groups) groupVisible.set(g.key, true);
        map.addSource("locations", { type: "geojson", data: locFC() });
        map.addLayer({
          id: "locations",
          type: "symbol",
          source: "locations",
          layout: {
            "text-field": ["get", "label"],
            "text-size": ["get", "size"],
            "text-anchor": "center",
            "text-allow-overlap": false,
          },
          paint: { "text-color": ["get", "color"], "text-halo-color": "#000", "text-halo-width": 1.6 },
        });
      }
    } catch {
      /* keine Locations */
    }
    buildLayersPanel();
    buildMapLangSelector();
  });

  const layersPanel = root.querySelector<HTMLDivElement>("#layersPanel")!;
  root.querySelector("#layersBtn")!.addEventListener("click", () => (layersPanel.hidden = !layersPanel.hidden));

  function buildLayersPanel(): void {
    const rows: string[] = [`<div class="fav-head">${t('layers.heading')}</div>`];
    for (const ly of ["sat", "grid", "terrain"]) {
      if (!map.getLayer(ly)) continue;
      rows.push(
        `<label><input type="checkbox" data-base="${ly}" ${baseLayerVisible[ly] !== false ? "checked" : ""}/> ${ly}</label>`,
      );
    }
    if (map.getLayer("topo")) rows.push(`<label><input type="checkbox" data-topo /> ${t('layers.topo')}</label>`);
    if (locData) {
      rows.push(`<div class="fav-head">${t('layers.places')}</div>`);
      for (const g of locData.groups) {
        rows.push(
          `<label><input type="checkbox" data-group="${g.key}" checked/> ${g.label} <span class="muted">${g.items.length}</span></label>`,
        );
      }
    }
    layersPanel.innerHTML = rows.join("");
    layersPanel.querySelectorAll<HTMLInputElement>("[data-base]").forEach((cb) =>
      cb.addEventListener("change", () => {
        baseLayerVisible[cb.dataset.base!] = cb.checked;
        map.setLayoutProperty(cb.dataset.base!, "visibility", cb.checked ? "visible" : "none");
      }),
    );
    layersPanel.querySelector<HTMLInputElement>("[data-topo]")?.addEventListener("change", (e) =>
      map.setLayoutProperty("topo", "visibility", (e.target as HTMLInputElement).checked ? "visible" : "none"),
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

  // ── Koordinaten-Grid mit Randbeschriftung (wie ATAKmaps) ───────────────
  const gridCanvas = root.querySelector<HTMLCanvasElement>("#gridCanvas")!;
  const gctx = gridCanvas.getContext("2d")!;
  function drawGrid(): void {
    const w = gridCanvas.clientWidth;
    const h = gridCanvas.clientHeight;
    if (gridCanvas.width !== w) gridCanvas.width = w;
    if (gridCanvas.height !== h) gridCanvas.height = h;
    gctx.clearRect(0, 0, w, h);
    if (!cal) return;
    const b = map.getBounds();
    const [x0, y0] = lngLatToWorld(cal, b.getWest(), b.getSouth());
    const [x1, y1] = lngLatToWorld(cal, b.getEast(), b.getNorth());
    const span = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    const step = niceStep(span / 8);
    gctx.strokeStyle = "rgba(255,255,255,0.18)";
    gctx.fillStyle = "rgba(255,255,255,0.85)";
    gctx.font = "11px system-ui";
    gctx.lineWidth = 1;
    for (let gx = Math.ceil(Math.min(x0, x1) / step) * step; gx <= Math.max(x0, x1); gx += step) {
      const ll = worldToLngLat(cal, gx, y0);
      const px = map.project(ll).x;
      gctx.beginPath();
      gctx.moveTo(px, 0);
      gctx.lineTo(px, h);
      gctx.stroke();
      gctx.fillText(String(Math.round(gx)), px + 2, 12);
    }
    for (let gy = Math.ceil(Math.min(y0, y1) / step) * step; gy <= Math.max(y0, y1); gy += step) {
      const ll = worldToLngLat(cal, x0, gy);
      const py = map.project(ll).y;
      gctx.beginPath();
      gctx.moveTo(0, py);
      gctx.lineTo(w, py);
      gctx.stroke();
      gctx.fillText(String(Math.round(gy)), 2, py - 2);
    }
  }
  map.on("move", drawGrid);
  map.on("resize", drawGrid);
  map.once("idle", drawGrid);

  if (!canEdit) return;

  // ── Werkzeugleiste ────────────────────────────────────────────────────
  const toolbar = root.querySelector<HTMLDivElement>("#toolbar")!;
  const lineStylePanel = root.querySelector<HTMLDivElement>("#lineStyle")!;
  let linePts: [number, number][] = [];
  let chainGroup: number | null = null;
  let chainIndex = 0;

  const refreshLineDraft = () =>
    (map.getSource("linedraft") as GeoJSONSource)?.setData(lineDraftFC(linePts));

  const setMode = (m: Mode) => {
    mode = m;
    toolbar.querySelectorAll("[data-mode]").forEach((b) =>
      b.classList.toggle("active", (b as HTMLElement).dataset.mode === m),
    );
    map.getCanvas().style.cursor = m === "place" || m === "line" ? "crosshair" : m === "erase" ? "not-allowed" : "";
    // Zeigen + Linie + Radierer: Karte fixieren (kein Greifen)
    if (m === "point" || m === "line" || m === "erase") {
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
    if (m !== "place") {
      pending = null;
      chainGroup = null;
    }
  };
  toolbar.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => setMode(b.dataset.mode as Mode)),
  );
  root.querySelector("#tool-marker")!.addEventListener("click", () => {
    openWizard(root, (tpl) => {
      chainGroup = tpl.is_multipoint ? Math.floor(Math.random() * 1e9) : null;
      chainIndex = 0;
      setMode("place");
      pending = tpl; // nach setMode setzen (setMode('place') fasst pending nicht an)
    });
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
                <img src="${iconUrl(f.sidc)}" width="24" height="24" onerror="this.style.visibility='hidden'"/>
                <span>${f.label}</span><button data-delfav="${f.id}">✕</button></div>`,
            )
            .join("")
        : `<div class="muted">${t("fav.hint")}</div>`);
    favPanel.querySelectorAll<HTMLElement>("[data-fav]").forEach((el) =>
      el.addEventListener("click", (ev) => {
        if ((ev.target as HTMLElement).dataset.delfav) return;
        const f = favs.find((x) => x.id === el.dataset.fav)!;
        chainGroup = null;
        setMode("place");
        pending = {
          sidc: f.sidc,
          unit_text: f.unit_text,
          ai_text: f.ai_text,
          channel: myChannel,
          locked: false,
          timestamp_visible: true,
          rotation_degrees: f.rotation_degrees,
          is_multipoint: false,
          max_line_points: 0,
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
  map.on("click", "marker-icon", (e) => {
    e.preventDefault();
    const id = e.features?.[0]?.properties?.id as string;
    const m = markers.get(id);
    if (!m) return;
    if (mode === "erase") {
      if (caps.delete) socket.send({ type: "marker.delete", id: m.id });
    } else if (mode === "move") {
      openEditPanel(m);
    }
  });

  map.on("dblclick", (e) => {
    if (mode === "line") {
      e.preventDefault();
      finishLine();
    }
  });

  map.on("click", (e) => {
    if ((e as { defaultPrevented?: boolean }).defaultPrevented) return;

    if (mode === "line") {
      linePts.push([e.lngLat.lng, e.lngLat.lat]);
      refreshLineDraft();
      return;
    }

    if (mode === "place" && pending) {
      const data: Record<string, unknown> = {
        sidc: pending.sidc,
        world_x: e.lngLat.lng,
        world_y: e.lngLat.lat,
        unit_text: pending.unit_text,
        ai_text: pending.ai_text,
        channel: pending.channel || myChannel,
        locked: pending.locked,
        timestamp_visible: pending.timestamp_visible,
        rotation_degrees: pending.rotation_degrees,
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

      const done = !pending.is_multipoint || (pending.max_line_points > 0 && chainIndex >= pending.max_line_points);
      if (done) setMode("move");
    }
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      if (mode === "line" && linePts.length) finishLine();
      else setMode("move");
    }
  });

  // ── Marker-Edit-Panel ─────────────────────────────────────────────────
  function openEditPanel(m: Marker): void {
    root.querySelector("#editPanel")?.remove();
    const p = document.createElement("div");
    p.className = "edit-panel";
    p.id = "editPanel";
    p.innerHTML = `
      <div class="fav-head"><img src="${iconUrl(m.sidc)}" width="26" height="26" onerror="this.style.visibility='hidden'"/> ${t("marker.heading")}</div>
      <label>${t("marker.unitText")}</label><input data-unit value="${m.unit_text}" />
      <label>${t("marker.aiText")}</label><input data-ai value="${m.ai_text}" />
      <label>${t("marker.iconRot")}</label><input data-rot type="number" value="${m.icon_rotation || 0}" />
      <label><input type="checkbox" data-lock ${m.locked ? "checked" : ""}/> ${t("marker.locked")}</label>
      <div class="row">
        <button class="primary" data-apply>${t("common.apply")}</button>
        <button data-fav>${t("fav.add")}</button>
        <button data-clone>${t("marker.clone")}</button>
        <button data-del>${t("common.delete")}</button>
      </div>`;
    root.appendChild(p);
    p.querySelector("[data-apply]")!.addEventListener("click", () => {
      socket.send({
        type: "marker.modify",
        id: m.id,
        data: {
          unit_text: p.querySelector<HTMLInputElement>("[data-unit]")!.value,
          ai_text: p.querySelector<HTMLInputElement>("[data-ai]")!.value,
          icon_rotation: Number(p.querySelector<HTMLInputElement>("[data-rot]")!.value) || 0,
        },
      });
      socket.send({ type: "marker.lock", id: m.id, locked: p.querySelector<HTMLInputElement>("[data-lock]")!.checked });
      p.remove();
    });
    p.querySelector("[data-del]")!.addEventListener("click", () => {
      socket.send({ type: "marker.delete", id: m.id });
      p.remove();
    });
    p.querySelector("[data-clone]")!.addEventListener("click", () => {
      chainGroup = null;
      setMode("place");
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
      p.remove();
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
      });
      favs = await api.favorites();
      renderFavs();
      favPanel.hidden = false;
    });
  }

  root.querySelector("#save")?.addEventListener("click", async () => {
    await api.saveVersion(planId, prompt(t("plan.versionLabel")) ?? "");
    alert(t("plan.versionSaved"));
  });
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
