// Plan-Ansicht: Karte + Werkzeugleiste + HUD + Marker/Zeichnen/Präsenz live.
// Nähert sich der ATAKmaps-UI an (D:\Mods\ATAKmaps).
import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import { api, type Me } from "./api";
import { channelLabel, channelVisibility, describe, loadAllMarkers, loadChannels, loadModifiers, loadPhaseLineStyle, loadTranslations, translate } from "./sidc/catalog";
import { lngLatToWorld, withModifiers, worldToLngLat, type Calibration, type SidcModifiers } from "./sidc/sidc";
import { openWizard, type MarkerTemplate } from "./sidc/wizard";
import { confirmDialog, promptDialog, toast, toastError } from "./notify";
import { makeMovable } from "./movable";
import { ensureMapIcon, iconSrc } from "./sidc/symbol";
import { openAclEditor } from "./acl";
import { openHelp } from "./help";
import { openVersionPanel } from "./versions";
import { t } from "./i18n";
import { icon } from "./icons";
import { iconBtn, themeSwitch, wireThemeSwitch } from "./ui";
import { modeForKey, openSettings } from "./settings";
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
  author?: string;
  locked: boolean;
  rotation_degrees: number;
  icon_rotation: number;
  scale?: number;
  phase_id: string | null;
  layer_id: string | null;
  orbat_node_id?: string | null;
  orbat_strength?: number;
  released?: boolean;
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
  phase_id?: string | null;
  channel?: string;
}
type Mode = "move" | "markermove" | "point" | "line" | "erase" | "place" | "measure" | "text";

interface Annot {
  id: string;
  phase_id: string | null;
  world_x: number;
  world_y: number;
  text: string;
  width: number;
  height?: number;
  scale_fixed?: boolean;
  ref_zoom?: number;
}

export async function openPlanView(root: HTMLElement, planId: string, me: Me): Promise<void> {
  const snap = await api.snapshot(planId);
  const mapId: string = snap.plan.map_id;
  const cal: Calibration | null = snap.map_meta?.calibration ?? null;
  const markers = new Map<string, Marker>(snap.markers.map((m: Marker) => [m.id, m]));
  const strokes = new Map<string, Stroke>(snap.strokes.map((s: Stroke) => [s.id, s]));
  const annots = new Map<string, Annot>(
    (snap.annotations ?? []).map((a: Annot) => [a.id, a]),
  );
  const myPlan = (await api.plans()).find((p) => p.id === planId);
  const canEdit = myPlan?.level === "editor" || myPlan?.level === "owner";
  const channels = await loadChannels();
  const lineStyle = await loadPhaseLineStyle();
  const modCat = await loadModifiers();
  // SIDC (Symbolset + Entity) → subCategory, um die Modifikatoren eines
  // platzierten Markers im Bearbeiten-Panel zu kennen.
  const subCatBySidc = new Map<string, string>();
  const nameBySidc = new Map<string, string>();
  const langKeyBySidc = new Map<string, string>();
  await loadTranslations();
  for (const c of (await loadAllMarkers()) ?? [])
    for (const e of c.entries) {
      const key = e.sidc.slice(4, 6) + e.sidc.slice(10, 16);
      if (e.subCategory) subCatBySidc.set(key, e.subCategory);
      if (e.name && !nameBySidc.has(key)) nameBySidc.set(key, translate(e.name));
      if (e.languageKey && !langKeyBySidc.has(key)) langKeyBySidc.set(key, e.languageKey);
    }
  const markerInfoText = (sidc: string): string =>
    describe(langKeyBySidc.get(sidc.slice(4, 6) + sidc.slice(10, 16)));

  // Marker-Beschriftung: Name + (falls gesetzt) Modifikatoren, per Komma getrennt.
  const MOD_SLOTS: [string, (s: string) => string][] = [
    ["modifier1", (s) => s.slice(16, 18)],
    ["modifier2", (s) => s.slice(18, 20)],
    ["modifier3", (s) => s.slice(7, 8)],
    ["modifier4", (s) => s.slice(6, 7)],
  ];
  const markerModifierLabels = (sidc: string): string[] => {
    const sub = subCatBySidc.get(sidc.slice(4, 6) + sidc.slice(10, 16));
    const defs = sub && modCat ? modCat[sub] : undefined;
    if (!defs) return [];
    const out: string[] = [];
    for (const [slot, pick] of MOD_SLOTS) {
      const code = Number(pick(sidc) || "0");
      if (!code) continue;
      const opt = (defs[slot] ?? []).find((o) => Number(o.code) === code);
      if (opt?.description) out.push(opt.description);
    }
    return out;
  };
  const markerLabel = (m: Marker): string => {
    const base = m.unit_text || nameBySidc.get(m.sidc.slice(4, 6) + m.sidc.slice(10, 16)) || "";
    return [base, ...markerModifierLabels(m.sidc)].filter(Boolean).join(", ");
  };
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
  const _chCur = localStorage.getItem(`sidc_channel_${planId}`) || channels?.currentChannel || "";
  let myChannel =
    channels?.channels.find((c) => c.name === _chCur || c.languageKey === _chCur)?.name ?? _chCur;
  let is3D = false;

  // Phasen / Zeitstrahl (+ Missionsbau-Parallelebene)
  interface PhaseT {
    id: string;
    name: string;
    ordering: number;
    notes: string;
    plane?: "player" | "builder";
    parent_id?: string | null;
    sub_ordering?: number;
    start_at?: string | null;
    end_at?: string | null;
  }
  const isMB: boolean = !!me.is_mission_builder_effective;
  const phases: PhaseT[] = [...(snap.phases ?? [])].sort(
    (a: PhaseT, b: PhaseT) => a.ordering - b.ordering || (a.sub_ordering ?? 0) - (b.sub_ordering ?? 0),
  );
  const isBuilderPhase = (id: string | null | undefined): boolean =>
    !!id && phases.some((p) => p.id === id && p.plane === "builder");
  const playerPhases = (): PhaseT[] => phases.filter((p) => (p.plane ?? "player") === "player");
  const builderChildren = (playerId: string): PhaseT[] =>
    phases
      .filter((p) => p.plane === "builder" && p.parent_id === playerId)
      .sort((a, b) => (a.sub_ordering ?? 0) - (b.sub_ordering ?? 0));

  let currentPhaseId: string = playerPhases()[0]?.id ?? phases[0]?.id ?? "";
  let actAs: "player" | "builder" =
    isMB && localStorage.getItem(`sidc_actas_${planId}`) === "builder" ? "builder" : "player";
  const activePlayerId = (): string => {
    const cur = phases.find((p) => p.id === currentPhaseId);
    return cur?.plane === "builder" ? cur.parent_id ?? "" : currentPhaseId;
  };
  let outOpacity = Number(localStorage.getItem("sidc_phaseopacity") ?? "20"); // % fremde Phasen
  if (!Number.isFinite(outOpacity)) outOpacity = 20;
  let crossOpacity = Number(localStorage.getItem("sidc_crossopacity") ?? "20"); // % andere Ebene
  if (!Number.isFinite(crossOpacity)) crossOpacity = 20;
  let personalScale = Number(localStorage.getItem("sidc_marker_scale") ?? "1"); // nur für mich
  if (!Number.isFinite(personalScale) || personalScale <= 0) personalScale = 1;
  const phaseListeners: (() => void)[] = []; // z. B. Notiz-Fenster bei Phasenwechsel
  const phaseOpacityOf = (phaseId: string | null | undefined): number => {
    if (phaseId == null) return 1;
    const mB = isBuilderPhase(phaseId);
    const curB = isBuilderPhase(currentPhaseId);
    if (mB !== curB) return Math.max(0, Math.min(100, crossOpacity)) / 100; // andere Ebene
    if (phaseId === currentPhaseId) return 1;
    return Math.max(0, Math.min(100, outOpacity)) / 100; // Fremdphase (gleiche Ebene)
  };
  const phaseOpacity = (m: Marker): number =>
    phaseOpacityOf(m.phase_id) *
    (m.released ? 0.6 : 1) *
    channelVisibility(channels?.channels, myChannel, m.channel);
  const phaseNameOf = (id: string | null): string =>
    id ? (phases.find((p) => p.id === id)?.name ?? "—") : t("phase.global");

  root.innerHTML = `
    <div class="topbar">
      <a href="#/" title="${t("nav.back")}">${icon("back")}</a>
      <strong>${snap.plan.name}</strong>
      <span class="badge" title="${t("plan.yourRole")}">${myPlan?.level ?? "?"}</span>
      <button id="t3d" title="${t("map.threeD")}">3D</button>
      ${iconBtn("north", { id: "compass", cls: "compass", title: t("map.compass") })}
      ${
        canEdit
          ? iconBtn("undo", { id: "undo", title: t("edit.undo") }) +
            iconBtn("redo", { id: "redo", title: t("edit.redo") })
          : ""
      }
      <input type="datetime-local" id="dtg" title="${t("map.dtg")}" />
      ${iconBtn("camera", { id: "shot", title: t("map.screenshot") })}
      ${iconBtn("pdf", { id: "briefing", title: t("briefing.export") })}
      <select id="chan" title="${t('map.channel')}">${(channels?.channels ?? [])
        .map((c) => `<option value="${c.name}" ${c.name === myChannel ? "selected" : ""}>${channelLabel(c)}</option>`)
        .join("")}</select>
      <div id="timeline" class="timeline"></div>
      <select id="maplang" title="${t("map.lang")}"></select>
      <span class="grow"></span>
      <span class="presence" id="presence"></span>
      ${iconBtn("present", { id: "present", title: t("present.start") })}
      ${iconBtn("versions", { id: "versions", title: t("versions.open") })}
      ${iconBtn("help", { id: "help", title: t("help.open") })}
      ${iconBtn("settings", { id: "settingsBtn", title: t("settings.open") })}
      ${myPlan?.level === "owner" ? `<button id="acl">${t("plans.shares")}</button>` : ""}
      ${themeSwitch()}
    </div>
    <div id="map"></div>
    <div id="annots" class="annots"></div>
    <div class="toolbar" id="toolbar">
      ${
        canEdit
          ? iconBtn("pan", { data: { mode: "move" }, active: true, title: t("tool.move") }) +
            iconBtn("markerMove", { data: { mode: "markermove" }, title: t("tool.markermove") }) +
            iconBtn("point", { data: { mode: "point" }, title: t("tool.point") }) +
            iconBtn("line", { data: { mode: "line" }, title: t("tool.line") }) +
            iconBtn("ruler", { data: { mode: "measure" }, title: t("tool.measure") }) +
            iconBtn("eraser", { data: { mode: "erase" }, title: t("tool.erase") }) +
            iconBtn("textbox", { data: { mode: "text" }, title: t("tool.text") }) +
            iconBtn("marker", { id: "tool-marker", title: t("tool.marker") }) +
            iconBtn("star", { id: "tool-fav", title: t("tool.fav") }) +
            `<span class="tb-sep"></span>`
          : ""
      }
      ${iconBtn("layers", { id: "layersBtn", title: t("tool.layers") })}
      ${iconBtn("groups", { id: "orbatBtn", title: t("orbat.inPlan") })}
    </div>
    ${
      canEdit
        ? `<div class="fav-panel" id="favPanel" hidden></div>
           <div class="line-style" id="lineStyle" hidden>
             <div class="fav-head">${t("line.heading")}</div>
             <label>${t("line.color")}</label>
             <div id="lc" class="line-colors"></div>
             <label>${t("line.width")}</label>
             <select id="lw">${lineWidths
               .map((w) => `<option value="${w.width}" ${w.width === lineWidth ? "selected" : ""}>${w.width}</option>`)
               .join("")}</select>
             <label>${t("phase.assign")}</label>
             <select id="lPhase">
               <option value="">${t("phase.global")}</option>
               ${phases
                 .map((ph) => `<option value="${ph.id}">${ph.plane === "builder" ? "⚑ " : ""}${ph.name}</option>`)
                 .join("")}
             </select>
             <label>${t("wiz.channel")}</label>
             <select id="lChan">${(channels?.channels ?? [])
               .map((c) => `<option value="${c.name}">${channelLabel(c)}</option>`)
               .join("")}</select>
             <button class="primary" id="lineFinish">${t("line.finish")}</button>
             <p class="muted" style="margin:.35rem 0 0;font-size:.72rem">${t("line.rmbHint")}</p>
           </div>`
        : ""
    }
    <div class="hud" id="hud">X: –  Y: –  H: –</div>
    <div class="mk-scale" id="mkScale" title="${t("marker.scaleLocal")}">
      ${icon("marker", 13)}
      <input type="range" id="mkScaleIn" min="25" max="300" step="5" value="${Math.round(personalScale * 100)}" />
      <span id="mkScaleV">${Math.round(personalScale * 100)}%</span>
    </div>
    <button class="line-done" id="lineDone" title="${t("line.finish")}" hidden>${icon("check", 18)}</button>
    <button class="line-done line-gear" id="strokeGear" title="${t("line.edit")}" hidden>${icon("settings", 16)}</button>
    <div class="navcube" id="navcube" title="${t("map.navcube")}" hidden>
      <div class="ncube">
        <button class="ncf ncf-top" data-face="top">▲</button>
        <button class="ncf ncf-n" data-face="n">N</button>
        <button class="ncf ncf-s" data-face="s">S</button>
        <button class="ncf ncf-e" data-face="e">O</button>
        <button class="ncf ncf-w" data-face="w">W</button>
      </div>
    </div>
    <div class="layers-panel" id="layersPanel" hidden></div>
    <div class="layers-panel orbat-panel" id="orbatPanel" hidden></div>
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

  // Topbar bricht je nach Fensterbreite/Zeitleiste auf mehrere Zeilen um — die
  // Karte darunter richtet sich nach der tatsächlichen Topbar-Höhe (CSS-Variable).
  const topbarEl = root.querySelector<HTMLElement>(".topbar")!;
  const syncTopbarH = () => {
    root.style.setProperty("--topbar-h", `${topbarEl.offsetHeight}px`);
    map.resize();
  };
  syncTopbarH();
  const topbarRO = new ResizeObserver(syncTopbarH);
  topbarRO.observe(topbarEl);
  window.addEventListener("resize", syncTopbarH);
  window.addEventListener(
    "hashchange",
    () => {
      topbarRO.disconnect();
      window.removeEventListener("resize", syncTopbarH);
      root.style.removeProperty("--topbar-h");
    },
    { once: true },
  );

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
        label: markerLabel(m),
        rot: m.icon_rotation || 0,
        locked: m.locked,
        dot: missingIcons.has(m.sidc),
        opacity: phaseOpacity(m),
        scale: Math.max(0.25, Math.min(3, m.scale ?? 1)) * personalScale,
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
      properties: {
        id: s.id,
        color: packedToHex(s.color),
        width: s.width > 0 ? s.width : 2,
        opacity:
          phaseOpacityOf(s.phase_id) *
          channelVisibility(channels?.channels, myChannel, s.channel || ""),
      },
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
    // Endpunkte um ~16 px zum Nachbarn einrücken, damit das Icon frei bleibt.
    const trim = (from: [number, number], toward: [number, number], px: number): [number, number] => {
      const a = map.project(from);
      const b = map.project(toward);
      const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const f = Math.min(0.45, px / d);
      const ll = map.unproject([a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f]);
      return [ll.lng, ll.lat];
    };
    const feats: GeoJSON.Feature[] = [];
    for (const list of byGroup.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.point_index - b.point_index);
      const anchor = list[0];
      const pts = list.map((m) => [m.world_x, m.world_y] as [number, number]);
      pts[0] = trim(pts[0], pts[1], 16);
      pts[pts.length - 1] = trim(pts[pts.length - 1], pts[pts.length - 2], 16);
      feats.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: pts },
        properties: {
          color: packedToHex(anchor.line_color),
          width: anchor.line_width > 0 ? anchor.line_width : 2,
          // gleiche Sichtbarkeit wie die Marker der Kette (schwächster gewinnt)
          opacity: Math.min(...list.map((m) => phaseOpacity(m))),
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
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["get", "width"],
        "line-opacity": ["coalesce", ["get", "opacity"], 1],
      },
      layout: { "line-cap": "round", "line-join": "round" },
    });

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
        "circle-radius": 6,
        "circle-color": "#ff9900",
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 2,
      },
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
      layout: {
        "icon-image": ["get", "sidc"],
        "icon-size": ["*", 0.8, ["coalesce", ["get", "scale"], 1]],
        "icon-rotate": ["get", "rot"],
        "icon-allow-overlap": true,
        "text-field": ["get", "label"],
        "text-optional": true,
        "text-size": 11,
        "text-anchor": "top",
        "text-offset": [0, 1.4],
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

    // Start in 2D: KEIN Terrain-Mesh (ressourcenschonend). Die Cursor-Höhe kommt
    // in 2D aus den DEM-Kacheln (sampleElevation), in 3D aus dem Terrain.
  });

  const refreshDir = () => {
    const d = dirFC();
    (map.getSource("dir-lines") as GeoJSONSource)?.setData(d.lines);
    (map.getSource("dir-heads") as GeoJSONSource)?.setData(d.heads);
  };
  const refreshStrokes = () => (map.getSource("strokes") as GeoJSONSource)?.setData(strokeFC());
  const refreshMarkers = async () => {
    await Promise.all([...new Set([...markers.values()].map((m) => m.sidc))].map(ensureIcon));
    (map.getSource("markers") as GeoJSONSource)?.setData(markerFC());
    (map.getSource("chains") as GeoJSONSource)?.setData(chainFC());
    refreshDir();
    refreshStrokes(); // Phase/Channel steuern auch die Deckkraft der Linien
  };

  // ── Linien nachträglich bearbeiten: Stützpunkte ziehen ───────────────
  // Lineal: mehrsegmentige, bleibende Messlinien (nur lokal, je Sitzung)
  // builder=true → nur in der Missionsbau-Ebene sichtbar, sonst nur in der Spieler-Ebene
  let measureLines: { id: string; pts: [number, number][]; builder: boolean }[] = [];
  let measureActive: [number, number][] = [];
  let measureCursor: [number, number] | null = null;
  let editMeasureId: string | null = null;
  let editStrokeId: string | null = null;
  let onEditSelChange: () => void = () => {}; // wird später auf die Button-Positionierung gesetzt
  const editPts = (): [number, number][] | undefined =>
    editMeasureId
      ? measureLines.find((x) => x.id === editMeasureId)?.pts
      : editStrokeId
        ? strokes.get(editStrokeId)?.points
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
    editStrokeId = id;
    if (id) editMeasureId = null;
    refreshStrokeVerts();
    onEditSelChange();
  };
  const setEditMeasure = (id: string | null) => {
    editMeasureId = id;
    if (id) editStrokeId = null;
    refreshStrokeVerts();
    onEditSelChange();
  };
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

  // ── Undo/Redo (eigene Aktionen: verschieben, bearbeiten, sperren) ─────
  interface Cmd {
    undo: () => void;
    redo: () => void;
  }
  const undoStack: Cmd[] = [];
  const redoStack: Cmd[] = [];
  const UNDO_MAX = 60;
  const updateUndoBtns = (): void => {
    root.querySelector<HTMLButtonElement>("#undo")?.toggleAttribute("disabled", !undoStack.length);
    root.querySelector<HTMLButtonElement>("#redo")?.toggleAttribute("disabled", !redoStack.length);
  };
  const pushCmd = (c: Cmd): void => {
    undoStack.push(c);
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    redoStack.length = 0;
    updateUndoBtns();
  };
  const doUndo = (): void => {
    const c = undoStack.pop();
    if (!c) return;
    c.undo();
    redoStack.push(c);
    updateUndoBtns();
  };
  const doRedo = (): void => {
    const c = redoStack.pop();
    if (!c) return;
    c.redo();
    undoStack.push(c);
    updateUndoBtns();
  };

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
        if (editStrokeId === msg.stroke.id) refreshStrokeVerts();
        break;
      case "stroke.delete":
        strokes.delete(msg.id);
        refreshStrokes();
        if (editStrokeId === msg.id) setEditStroke(null);
        break;
      case "annotation.upsert": {
        const wasResizing = annotResizingId === msg.annotation.id;
        annots.set(msg.annotation.id, msg.annotation);
        if (!annotResizingId) renderAnnots(); // während eines Resize nicht neu aufbauen
        else if (!wasResizing) positionAnnots();
        if (msg.cid && msg.cid === pendingAnnotCid) {
          pendingAnnotCid = null;
          openAnnotEditor(msg.annotation.id, true);
        }
        break;
      }
      case "annotation.delete":
        annots.delete(msg.id);
        renderAnnots();
        break;
    }
  });
  socket.connect();
  window.addEventListener("hashchange", () => socket.close(), { once: true });

  // ── Höhe aus den DEM-Kacheln lesen (terrarium-Encoding) ───────────────
  // Funktioniert auch ohne aktives Terrain-Mesh — so bleibt 2D ressourcenschonend.
  let demZoom = 0;
  const demImg = new Map<string, ImageData | null>();
  const demBusy = new Set<string>();
  const sampleElevation = (lng: number, lat: number): number | null => {
    if (!demZoom) {
      const ts = (() => {
        try {
          return map.getStyle()?.sources?.["terrain-dem"] as
            | { minzoom?: number; maxzoom?: number }
            | undefined;
        } catch {
          return undefined;
        }
      })();
      if (!ts) return null;
      demZoom = Math.min(ts.maxzoom ?? 12, Math.max(ts.minzoom ?? 0, 12));
    }
    const n = 2 ** demZoom;
    const xf = ((lng + 180) / 360) * n;
    const latR = (lat * Math.PI) / 180;
    const yf = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
    const tx = Math.floor(xf);
    const ty = Math.floor(yf);
    if (tx < 0 || ty < 0 || tx >= n || ty >= n) return null;
    const key = `${demZoom}/${tx}/${ty}`;
    const img = demImg.get(key);
    if (img === undefined) {
      if (!demBusy.has(key)) {
        demBusy.add(key);
        const im = new Image();
        im.crossOrigin = "anonymous";
        im.onload = () => {
          try {
            const c = document.createElement("canvas");
            c.width = im.naturalWidth;
            c.height = im.naturalHeight;
            const cx = c.getContext("2d", { willReadFrequently: true })!;
            cx.drawImage(im, 0, 0);
            demImg.set(key, cx.getImageData(0, 0, c.width, c.height));
          } catch {
            demImg.set(key, null);
          }
          demBusy.delete(key);
        };
        im.onerror = () => {
          demImg.set(key, null);
          demBusy.delete(key);
        };
        im.src = `/api/maps/${mapId}/terrain/${demZoom}/${tx}/${ty}.png`;
      }
      return null;
    }
    if (img === null) return null;
    const px = Math.min(img.width - 1, Math.max(0, Math.floor((xf - tx) * img.width)));
    const py = Math.min(img.height - 1, Math.max(0, Math.floor((yf - ty) * img.height)));
    const i = (py * img.width + px) * 4;
    return img.data[i] * 256 + img.data[i + 1] + img.data[i + 2] / 256 - 32768;
  };

  // ── HUD (Cursor X/Y/Höhe) ──────────────────────────────────────────────
  const hud = root.querySelector<HTMLDivElement>("#hud")!;
  makeMovable(hud, { plan: planId, key: "hud" });
  makeMovable(root.querySelector<HTMLDivElement>("#mkScale")!, { plan: planId, key: "mkscale" });
  let lastCursorSent = 0;
  map.on("mousemove", (e) => {
    const [wx, wy] = lngLatToWorld(cal, e.lngLat.lng, e.lngLat.lat);
    let h = "–";
    try {
      const el = is3D
        ? (map.queryTerrainElevation(e.lngLat) ?? 0) / 1.5
        : sampleElevation(e.lngLat.lng, e.lngLat.lat);
      if (el != null) h = `${Math.round(el)} m`;
    } catch {
      /* keine Höhendaten */
    }
    hud.textContent = `X: ${wx.toFixed(0)}  Y: ${wy.toFixed(0)}  H: ${h}`;
    if (mode === "measure" && measureActive.length) {
      measureCursor = [e.lngLat.lng, e.lngLat.lat];
      redrawMeasure();
    }
    if (mode === "point" && Date.now() - lastCursorSent > 60) {
      lastCursorSent = Date.now();
      socket.send({ type: "presence.cursor", lng: e.lngLat.lng, lat: e.lngLat.lat });
      // eigener Zeiger auch bei mir anzeigen
      peers.set(me.id, { name: me.username, lng: e.lngLat.lng, lat: e.lngLat.lat, t: Date.now() });
      refreshPeers();
    }
  });

  // ── 2D/3D ─────────────────────────────────────────────────────────────
  const navcube = root.querySelector<HTMLDivElement>("#navcube")!;
  const ncube = navcube.querySelector<HTMLDivElement>(".ncube")!;
  const syncCube = () => {
    ncube.style.transform = `rotateX(${map.getPitch() - 90}deg) rotateZ(${map.getBearing()}deg)`;
  };
  map.on("rotate", syncCube);
  map.on("pitch", syncCube);
  map.on("load", syncCube);

  root.querySelector("#t3d")!.addEventListener("click", () => {
    is3D = !is3D;
    root.querySelector("#t3d")!.classList.toggle("active", is3D);
    navcube.hidden = !is3D;
    const hasDem = !!map.getSource("terrain-dem");
    if (is3D) {
      if (hasDem) map.setTerrain({ source: "terrain-dem", exaggeration: 1.5 });
      map.setMaxPitch(85);
      map.easeTo({ pitch: 60, duration: 700 });
    } else {
      // 2D: Terrain-Mesh abschalten → deutlich ressourcenschonender.
      map.easeTo({ pitch: 0, duration: 700 });
      map.once("moveend", () => {
        if (!is3D) {
          if (hasDem) map.setTerrain(null);
          map.setMaxPitch(0); // Kippen wieder sperren, Drehung bleibt
        }
      });
    }
  });

  // Navigations-Würfel: Flächen anklicken = Kamera in die Richtung schwenken,
  // Würfel mit gedrückter Maus drehen = Ansicht drehen/neigen.
  const FACE_BEARING: Record<string, number> = { n: 0, e: 90, s: 180, w: 270 };
  let cubeDragged = false;
  navcube.querySelectorAll<HTMLButtonElement>("[data-face]").forEach((b) =>
    b.addEventListener("click", () => {
      if (cubeDragged) {
        cubeDragged = false;
        return;
      }
      const f = b.dataset.face!;
      if (f === "top") map.easeTo({ pitch: 0, duration: 500 });
      else map.easeTo({ bearing: FACE_BEARING[f], pitch: 45, duration: 500 });
    }),
  );
  navcube.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const sb = map.getBearing();
    const sp = map.getPitch();
    cubeDragged = false;
    navcube.classList.add("drag");
    const mv = (ev: MouseEvent) => {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3) cubeDragged = true;
      map.setBearing(sb + (ev.clientX - sx) * 0.6);
      map.setPitch(Math.max(0, Math.min(85, sp - (ev.clientY - sy) * 0.4)));
    };
    const up = () => {
      document.removeEventListener("mousemove", mv);
      document.removeEventListener("mouseup", up);
      navcube.classList.remove("drag");
    };
    document.addEventListener("mousemove", mv);
    document.addEventListener("mouseup", up);
  });

  // ── Kompass + Nach-Norden-Button ──────────────────────────────────────
  wireThemeSwitch(root);
  const compass = root.querySelector<HTMLButtonElement>("#compass")!;
  const syncCompass = () => {
    compass.style.setProperty("--rot", `${-map.getBearing()}deg`);
  };
  map.on("rotate", syncCompass);
  map.on("load", syncCompass);
  compass.addEventListener("click", () => map.easeTo({ bearing: 0, duration: 400 }));

  // ── Datum/Zeit (DTG = H-Stunde) ──────────────────────────────────────
  const dtgInput = root.querySelector<HTMLInputElement>("#dtg")!;
  dtgInput.title = t("phase.hHour");
  {
    const raw = snap.plan.h_hour as string | null | undefined;
    if (raw) dtgInput.value = raw.slice(0, 16);
  }
  dtgInput.addEventListener("change", () => {
    opStart = dtgInput.value ? new Date(dtgInput.value) : defaultHHour();
    void api.patchPlan(planId, { h_hour: dtgInput.value || null }).catch((e) => toastError(e));
    renderTimeline();
    repaintNotesTimes();
  });
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

  // ── Briefing-PDF: je Phase eine Seite (Karte auf Phasen-Marker gerahmt) ──
  const briefingBtn = root.querySelector<HTMLButtonElement>("#briefing")!;
  briefingBtn.addEventListener("click", async () => {
    briefingBtn.disabled = true;
    const origPhase = currentPhaseId;
    const origCenter = map.getCenter();
    const origZoom = map.getZoom();
    const origBearing = map.getBearing();
    const safe = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "plan";
    const stripMd = (s: string) =>
      s
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/[*_`>#]/g, "")
        .replace(/^\s*[-*]\s+/gm, "• ")
        .trim();
    const idle = () =>
      new Promise<void>((res) => {
        if (map.loaded() && !map.isMoving()) return res();
        map.once("idle", () => res());
      });
    try {
      const { jsPDF } = await import("jspdf");
      const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      const pw = doc.internal.pageSize.getWidth();
      const ph = doc.internal.pageSize.getHeight();
      const d = shotDate();

      for (let pi = 0; pi < phases.length; pi++) {
        const phase = phases[pi];
        if (pi > 0) doc.addPage();
        currentPhaseId = phase.id;
        // Marker dieser Phase (+ globale) für den Bildausschnitt
        const pts = [...markers.values()]
          .filter((m) => m.phase_id === phase.id || m.phase_id == null)
          .map((m) => [m.world_x, m.world_y] as [number, number]);
        if (pts.length) {
          let m0 = pts[0].slice() as [number, number];
          let m1 = pts[0].slice() as [number, number];
          for (const p of pts) {
            m0 = [Math.min(m0[0], p[0]), Math.min(m0[1], p[1])];
            m1 = [Math.max(m1[0], p[0]), Math.max(m1[1], p[1])];
          }
          const padX = (m1[0] - m0[0]) * 0.1 || 0.0005;
          const padY = (m1[1] - m0[1]) * 0.1 || 0.0005;
          map.fitBounds(
            [
              [m0[0] - padX, m0[1] - padY],
              [m1[0] + padX, m1[1] + padY],
            ],
            { padding: 40, duration: 0, bearing: 0 },
          );
        }
        await refreshMarkers();
        await idle();
        map.redraw();
        const mc = map.getCanvas();
        const cvs = document.createElement("canvas");
        cvs.width = mc.width;
        cvs.height = mc.height;
        const cx = cvs.getContext("2d")!;
        cx.drawImage(mc, 0, 0);
        if (baseLayerVisible.grid !== false) cx.drawImage(gridCanvas, 0, 0, cvs.width, cvs.height);
        const img = cvs.toDataURL("image/jpeg", 0.9);

        // Layout: Titel oben, Karte links, Notizen rechts
        doc.setFontSize(16);
        doc.text(`${snap.plan.name} — ${phase.name}  (${pi + 1}/${phases.length})`, 12, 14);
        doc.setFontSize(9);
        doc.text(militaryDtg(d), pw - 12, 14, { align: "right" });
        const imgW = pw * 0.62 - 12;
        const imgH = (imgW * cvs.height) / cvs.width;
        doc.addImage(img, "JPEG", 12, 20, imgW, Math.min(imgH, ph - 28));
        const notes = stripMd(phase.notes || "");
        if (notes) {
          doc.setFontSize(10);
          const nx = 12 + imgW + 8;
          doc.text(doc.splitTextToSize(notes, pw - nx - 10), nx, 26);
        }
      }
      // ── Kräfteübersicht: ORBAT-Knoten, die auf der Karte stehen ──
      await ensureOrbatCache();
      const nodesOnMap = new Set(
        [...markers.values()].map((m) => m.orbat_node_id).filter(Boolean) as string[],
      );
      const forceItems = planOrbatCache.flatMap((o) =>
        (o.nodes ?? [])
          .filter((n) => o.released || nodesOnMap.has(n.id))
          .map((n) => ({ orbat: o.name, aff: o.affiliation, n })),
      );
      if (forceItems.length) {
        doc.addPage();
        doc.setFontSize(16);
        doc.text(`${snap.plan.name} — ${t("orbat.forcesTitle")}`, 12, 14);
        let y = 26;
        let curOrbat = "";
        for (const it of forceItems) {
          if (y > ph - 14) {
            doc.addPage();
            y = 20;
          }
          if (it.orbat !== curOrbat) {
            curOrbat = it.orbat;
            doc.setFontSize(12);
            doc.text(`${curOrbat}  (${t("orbat.aff." + it.aff)})`, 12, y);
            y += 7;
          }
          doc.setFontSize(10);
          const strength =
            it.n.qty_planned == null ? "?" : `${it.n.qty_current ?? "?"}/${it.n.qty_planned}`;
          doc.text(`• ${it.n.name}    ${strength}    ${t("orbat.status." + it.n.status)}`, 16, y);
          y += 6;
        }
      }
      const fileStamp =
        `${p2(d.getDate())}${p2(d.getMonth() + 1)}${d.getFullYear()}-` +
        `${p2(d.getHours())}${p2(d.getMinutes())}`;
      doc.save(`${safe(snap.plan.name)}_Briefing_${fileStamp}.pdf`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "PDF-Export fehlgeschlagen", { kind: "error" });
    } finally {
      currentPhaseId = origPhase;
      map.jumpTo({ center: origCenter, zoom: origZoom, bearing: origBearing });
      await refreshMarkers();
      renderTimeline();
      briefingBtn.disabled = false;
    }
  });

  root.querySelector("#acl")?.addEventListener("click", () => openAclEditor(planId, snap.plan.name));
  root.querySelector("#help")!.addEventListener("click", openHelp);
  root.querySelector("#present")!.addEventListener("click", startPresent);
  root.querySelector("#undo")?.addEventListener("click", doUndo);
  root.querySelector("#redo")?.addEventListener("click", doRedo);
  updateUndoBtns();
  if (canEdit) {
    const onUndoKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        doUndo();
      } else if (k === "y" || (k === "z" && e.shiftKey)) {
        e.preventDefault();
        doRedo();
      }
    };
    document.addEventListener("keydown", onUndoKey);
    window.addEventListener("hashchange", () => document.removeEventListener("keydown", onUndoKey), {
      once: true,
    });
  }

  // Plan-Vorschaubild (Thumbnail) — bei Versions-Speichern + einmal kurz nach dem Laden.
  async function captureThumb(): Promise<void> {
    if (!canEdit) return;
    try {
      await new Promise<void>((res) => {
        if (map.loaded() && !map.isMoving()) return res();
        map.once("idle", () => res());
      });
      map.redraw();
      const mc = map.getCanvas();
      const w = 400;
      const h = Math.round((w * mc.height) / mc.width);
      const out = document.createElement("canvas");
      out.width = w;
      out.height = h;
      out.getContext("2d")!.drawImage(mc, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((r) => out.toBlob(r, "image/png"));
      if (blob) await api.uploadThumbnail(planId, blob);
    } catch {
      /* Thumbnail ist optional */
    }
  }
  if (canEdit) setTimeout(() => void captureThumb(), 5000);

  root
    .querySelector("#versions")!
    .addEventListener("click", () =>
      openVersionPanel(planId, canEdit, myPlan?.level === "owner", () => void captureThumb()),
    );

  // ── Zeitstrahl / Phasen ───────────────────────────────────────────────
  const timelineEl = root.querySelector<HTMLDivElement>("#timeline")!;
  let toggleNotesWin: () => void = () => {}; // wird bei der Notiz-Fenster-Einrichtung gesetzt
  let repaintNotesTimes: () => void = () => {};

  // Naive ISO-Zeit als lokale Wanduhr interpretieren (kein UTC-Versatz).
  const parseNaive = (s: string): Date => new Date(/[Z+]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(" ", "T"));
  const fmtInput = (d: Date): string => {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const DUR = 60; // Standard-Dauer je Phase (min)
  const defaultHHour = (): Date => {
    const raw = snap.plan.h_hour as string | null | undefined;
    if (raw) return parseNaive(raw);
    const d = new Date();
    d.setHours(8, 0, 0, 0);
    return d;
  };
  let opStart = defaultHHour();

  let tlPxPerMin = Number(localStorage.getItem(`sidc_tl_zoom_${planId}`)) || 3.5;
  if (!Number.isFinite(tlPxPerMin) || tlPxPerMin <= 0) tlPxPerMin = 3.5;
  const setZoom = (v: number, anchorMin?: number, anchorPx?: number) => {
    tlPxPerMin = Math.max(0.015, Math.min(24, v));
    try {
      localStorage.setItem(`sidc_tl_zoom_${planId}`, String(tlPxPerMin));
    } catch {
      /* ignore */
    }
    renderTimeline();
    const sc = timelineEl.querySelector<HTMLElement>(".tl-scroll");
    if (sc && anchorMin != null && anchorPx != null) {
      sc.scrollLeft = anchorMin * tlPxPerMin - anchorPx;
    }
  };

  type Span = { s: number; e: number };
  const computeSpans = (): Map<string, Span> => {
    const out = new Map<string, Span>();
    const H = opStart.getTime();
    const mk = (p: PhaseT, fallbackStart: number): Span => {
      let s: number;
      let e: number;
      if (p.start_at) {
        s = parseNaive(p.start_at).getTime();
        e = p.end_at ? parseNaive(p.end_at).getTime() : s + DUR * 60000;
      } else {
        s = fallbackStart;
        e = p.end_at ? parseNaive(p.end_at).getTime() : s + DUR * 60000;
      }
      if (!(e > s)) e = s + 15 * 60000;
      return { s, e };
    };
    const players = phases
      .filter((p) => (p.plane ?? "player") === "player")
      .sort((a, b) => a.ordering - b.ordering);
    let cursor = H;
    for (const p of players) {
      const sp = mk(p, cursor);
      out.set(p.id, sp);
      cursor = sp.e;
    }
    const byParent = new Map<string, PhaseT[]>();
    for (const b of phases.filter((p) => p.plane === "builder")) {
      const k = b.parent_id ?? "";
      (byParent.get(k) ?? byParent.set(k, []).get(k)!).push(b);
    }
    for (const [pid, subs] of byParent) {
      const parent = out.get(pid);
      subs.sort((a, b) => (a.sub_ordering ?? 0) - (b.sub_ordering ?? 0));
      let bc = parent ? parent.s : H;
      for (const b of subs) {
        let sp: Span;
        if (!b.start_at && !b.end_at && subs.length === 1 && parent) sp = { ...parent };
        else sp = mk(b, bc);
        out.set(b.id, sp);
        bc = sp.e;
      }
    }
    return out;
  };
  const assignRows = (ids: string[], spans: Map<string, Span>): Map<string, number> => {
    const rowEnd: number[] = [];
    const rowOf = new Map<string, number>();
    for (const id of ids.slice().sort((a, b) => spans.get(a)!.s - spans.get(b)!.s)) {
      const sp = spans.get(id)!;
      let r = rowEnd.findIndex((end) => end <= sp.s);
      if (r === -1) {
        r = rowEnd.length;
        rowEnd.push(sp.e);
      } else rowEnd[r] = sp.e;
      rowOf.set(id, r);
    }
    return rowOf;
  };
  const TICKS = [15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080, 20160, 40320];
  const tickMin = (): number => TICKS.find((m) => m * tlPxPerMin >= 68) ?? TICKS[TICKS.length - 1];
  const fmtTick = (d: Date, step: number): string => {
    const p = (n: number) => String(n).padStart(2, "0");
    if (step < 1440) {
      const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
      return d.getHours() === 0 && d.getMinutes() === 0 ? `${p(d.getDate())}.${p(d.getMonth() + 1)}.` : hm;
    }
    if (step < 10080) return `${p(d.getDate())}.${p(d.getMonth() + 1)}.`;
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.`;
  };
  // Phase per Server + lokal aktualisieren, dann neu zeichnen.
  const patchPhaseTimes = (id: string, s: number | null, e: number | null): void => {
    const p = phases.find((x) => x.id === id);
    if (!p) return;
    p.start_at = s == null ? null : fmtInput(new Date(s));
    p.end_at = e == null ? null : fmtInput(new Date(e));
    void api
      .patchPhase(planId, id, { start_at: p.start_at, end_at: p.end_at })
      .catch((err) => toastError(err));
    renderTimeline();
    repaintNotesTimes();
  };
  function applyPhase(): void {
    renderTimeline();
    void refreshMarkers();
    phaseListeners.forEach((f) => f());
    updatePresentBar();
  }
  function selectPhase(id: string): void {
    if (id === currentPhaseId || !phases.some((p) => p.id === id)) return;
    currentPhaseId = id;
    applyPhase();
  }
  function selectPlayerPhase(pid: string): void {
    currentPhaseId = actAs === "builder" ? builderChildren(pid)[0]?.id ?? pid : pid;
    applyPhase();
  }
  function setActAs(mode: "player" | "builder"): void {
    actAs = mode;
    try {
      localStorage.setItem(`sidc_actas_${planId}`, mode);
    } catch {
      /* ignore */
    }
    const pid = activePlayerId();
    currentPhaseId = mode === "builder" ? builderChildren(pid)[0]?.id ?? pid : pid;
    applyPhase();
  }

  // ── Präsentationsmodus (Vollbild, nur Karte + Phasen-Umschalter) ──────
  let presentBar: HTMLElement | null = null;
  function updatePresentBar(): void {
    if (!presentBar) return;
    const list = playerPhases();
    const idx = list.findIndex((p) => p.id === activePlayerId());
    presentBar.querySelector(".pb-name")!.textContent =
      `${list[idx]?.name ?? "—"}  (${idx + 1}/${list.length})`;
  }
  function stepPhase(dir: number): void {
    const list = playerPhases();
    const idx = list.findIndex((p) => p.id === activePlayerId());
    const next = list[(idx + dir + list.length) % list.length];
    if (next) selectPlayerPhase(next.id);
  }
  function exitPresent(): void {
    root.classList.remove("presenting");
    presentBar?.remove();
    presentBar = null;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    document.removeEventListener("keydown", onPresentKey);
    map.resize();
  }
  const onPresentKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") exitPresent();
    else if (e.key === "ArrowRight" || e.key === "PageDown") stepPhase(1);
    else if (e.key === "ArrowLeft" || e.key === "PageUp") stepPhase(-1);
  };
  function startPresent(): void {
    root.classList.add("presenting");
    presentBar = document.createElement("div");
    presentBar.className = "present-bar";
    presentBar.innerHTML =
      `<button class="icon-btn" data-pb="prev">${icon("back")}</button>` +
      `<span class="pb-name"></span>` +
      `<button class="icon-btn" data-pb="next">${icon("chevron")}</button>` +
      `<button class="icon-btn" data-pb="exit" title="${t("present.exit")}">${icon("x")}</button>`;
    root.appendChild(presentBar);
    presentBar.querySelector('[data-pb="prev"]')!.addEventListener("click", () => stepPhase(-1));
    presentBar.querySelector('[data-pb="next"]')!.addEventListener("click", () => stepPhase(1));
    presentBar.querySelector('[data-pb="exit"]')!.addEventListener("click", exitPresent);
    document.addEventListener("keydown", onPresentKey);
    document.documentElement.requestFullscreen?.().catch(() => {});
    updatePresentBar();
    setTimeout(() => map.resize(), 60);
  }

  function addLocalPhase(p: PhaseT): void {
    phases.push({ ...p, notes: p.notes ?? "", plane: p.plane ?? "player" });
    phases.sort((a, b) => a.ordering - b.ordering || (a.sub_ordering ?? 0) - (b.sub_ordering ?? 0));
  }

  let tlFirstPaint = true;
  let tlKeepScroll = -1;
  const esc0 = (s: string) =>
    (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  function removePhaseLocal(delId: string): void {
    const gone = new Set([delId, ...phases.filter((p) => p.parent_id === delId).map((p) => p.id)]);
    for (let i = phases.length - 1; i >= 0; i--) if (gone.has(phases[i].id)) phases.splice(i, 1);
    for (const m of markers.values()) if (m.phase_id && gone.has(m.phase_id)) m.phase_id = null;
    for (const a of annots.values()) if (a.phase_id && gone.has(a.phase_id)) a.phase_id = null;
    if (gone.has(currentPhaseId)) currentPhaseId = playerPhases()[0]?.id ?? "";
    applyPhase();
    renderAnnots();
  }
  function renderTimeline(): void {
    const apid = activePlayerId();
    const prevScroll = timelineEl.querySelector<HTMLElement>(".tl-scroll")?.scrollLeft ?? -1;
    const spans = computeSpans();
    const step = tickMin();
    const stepMs = step * 60000;
    // Zeitbereich (Domäne)
    let dom0 = opStart.getTime();
    let dom1 = opStart.getTime() + 4 * 3600e3;
    for (const sp of spans.values()) {
      dom0 = Math.min(dom0, sp.s);
      dom1 = Math.max(dom1, sp.e);
    }
    dom0 = Math.floor(dom0 / stepMs) * stepMs - stepMs;
    dom1 = Math.ceil(dom1 / stepMs) * stepMs + stepMs;
    const xOf = (t: number) => ((t - dom0) / 60000) * tlPxPerMin;
    const W = Math.max(200, xOf(dom1));

    const players = phases.filter((p) => (p.plane ?? "player") === "player").map((p) => p.id);
    const builders = phases.filter((p) => p.plane === "builder").map((p) => p.id);
    const rowP = assignRows(players, spans);
    const rowB = assignRows(builders, spans);
    const maxRow = (m: Map<string, number>) => Math.max(0, ...[...m.values()].map((r) => r + 1));
    const laneH = (n: number) => Math.max(30, n * 26 + 6);

    const ticks: string[] = [];
    for (let t = Math.ceil(dom0 / stepMs) * stepMs; t <= dom1; t += stepMs) {
      ticks.push(
        `<div class="tl-tick" style="left:${xOf(t)}px"><span>${fmtTick(new Date(t), step)}</span></div>`,
      );
    }
    const bar = (id: string, plane: "player" | "builder", row: number): string => {
      const sp = spans.get(id)!;
      const p = phases.find((x) => x.id === id)!;
      const explicit = !!(p.start_at || p.end_at);
      const left = xOf(sp.s);
      const w = Math.max(26, xOf(sp.e) - left);
      const dur = Math.round((sp.e - sp.s) / 60000);
      const durTxt = dur >= 1440 ? `${(dur / 1440).toFixed(1)} d` : dur >= 60 ? `${(dur / 60).toFixed(dur % 60 ? 1 : 0)} h` : `${dur} min`;
      return (
        `<div class="tl-bar ${id === currentPhaseId ? "active" : ""} ${explicit ? "" : "tl-auto"}" ` +
        `data-pick="${id}" data-plane="${plane}" style="left:${left}px;width:${w}px;top:${row * 26}px" ` +
        `title="${esc0(p.name)} · ${durTxt}">` +
        (canEdit ? `<span class="tl-edge tl-edge-l" data-edge="l" data-id="${id}"></span>` : "") +
        `<span class="tl-bar-name">${esc0(p.name)}</span>` +
        (canEdit
          ? `<span class="tl-edge tl-edge-r" data-edge="r" data-id="${id}"></span>` +
            `<button class="tl-del" data-del="${id}" title="${t("common.delete")}">${icon("x", 12)}</button>`
          : "") +
        `</div>`
      );
    };

    const ctl =
      `<div class="tl-ctl">` +
      `<button class="icon-btn" id="ph-notes" title="${t("notes.open")}">${icon("notes", 16)}</button>` +
      `<span class="tl-zoom"><button id="tl-zout" title="${t("tl.zoomOut")}">−</button><button id="tl-zin" title="${t("tl.zoomIn")}">+</button></span>` +
      (isMB
        ? `<span class="segmented mb-actas">` +
          `<button class="seg-btn ${actAs === "player" ? "active" : ""}" data-as="player">${t("mb.player")}</button>` +
          `<button class="seg-btn ${actAs === "builder" ? "active" : ""}" data-as="builder">${t("mb.builder")}</button></span>`
        : "") +
      `<label class="ph-op" title="${t("phase.outOpacityHint")}">${t("phase.outOpacity")}` +
      `<input type="range" id="ph-op" min="0" max="100" step="5" value="${outOpacity}"/><span id="ph-op-v">${outOpacity}%</span></label>` +
      (isMB
        ? `<label class="ph-op" title="${t("mb.crossOpacityHint")}">${t("mb.crossOpacity")}` +
          `<input type="range" id="cross-op" min="0" max="100" step="5" value="${crossOpacity}"/><span id="cross-op-v">${crossOpacity}%</span></label>`
        : "") +
      (canEdit ? `<button id="ph-add" title="${t("phase.add")}">+ ${t("phase.heading")}</button>` : "") +
      `</div>`;

    timelineEl.innerHTML =
      `<div class="tl">` +
      ctl +
      `<div class="tl-scroll"><div class="tl-canvas" style="width:${W}px">` +
      `<div class="tl-lane tl-player" style="height:${laneH(maxRow(rowP))}px">` +
      players.map((id) => bar(id, "player", rowP.get(id) ?? 0)).join("") +
      `</div>` +
      `<div class="tl-ruler">${ticks.join("")}<div class="tl-hh" style="left:${xOf(opStart.getTime())}px" title="H">H</div></div>` +
      (isMB
        ? `<div class="tl-lane tl-builder" style="height:${laneH(maxRow(rowB))}px">` +
          builders.map((id) => bar(id, "builder", rowB.get(id) ?? 0)).join("") +
          (canEdit ? `<button id="sub-add" class="tl-subadd" title="${t("mb.subPhase")}">+</button>` : "") +
          `</div>`
        : "") +
      `</div></div></div>`;

    const scEl = timelineEl.querySelector<HTMLElement>(".tl-scroll")!;
    if (tlFirstPaint) {
      scEl.scrollLeft = Math.max(0, xOf(opStart.getTime()) - 48);
      tlFirstPaint = false;
    } else if (tlKeepScroll >= 0) {
      scEl.scrollLeft = tlKeepScroll;
    } else if (prevScroll >= 0) {
      scEl.scrollLeft = prevScroll;
    }
    tlKeepScroll = -1;

    scEl.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const r = scEl.getBoundingClientRect();
      const px = e.clientX - r.left + scEl.scrollLeft;
      setZoom(tlPxPerMin * (e.deltaY < 0 ? 1.18 : 1 / 1.18), px / tlPxPerMin, e.clientX - r.left);
    });
    timelineEl.querySelector("#tl-zin")?.addEventListener("click", () => setZoom(tlPxPerMin * 1.7));
    timelineEl.querySelector("#tl-zout")?.addEventListener("click", () => setZoom(tlPxPerMin / 1.7));

    timelineEl.querySelector("#ph-notes")?.addEventListener("click", () => toggleNotesWin());
    timelineEl.querySelectorAll<HTMLButtonElement>("[data-as]").forEach((b) =>
      b.addEventListener("click", () => setActAs(b.dataset.as as "player" | "builder")),
    );

    // Balken: klicken = wählen, ziehen = verschieben, Kanten = Dauer ändern
    const pickPhase = (id: string): void => {
      const p = phases.find((x) => x.id === id);
      if (!p) return;
      if (isMB) {
        const want = p.plane === "builder" ? "builder" : "player";
        if (actAs !== want) {
          actAs = want;
          try {
            localStorage.setItem(`sidc_actas_${planId}`, actAs);
          } catch {
            /* ignore */
          }
        }
      }
      currentPhaseId = id;
      applyPhase();
    };
    const snap15 = (min: number) => Math.round(min / 15) * 15;
    timelineEl.querySelectorAll<HTMLElement>(".tl-bar").forEach((el) => {
      const id = el.dataset.pick!;
      const startDrag = (ev: MouseEvent, edge: "" | "l" | "r") => {
        if (!canEdit) {
          if (!edge) pickPhase(id);
          return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        const sp = { ...spans.get(id)! };
        const x0 = ev.clientX;
        const origLeft = parseFloat(el.style.left) || 0;
        const origW = parseFloat(el.style.width) || 26;
        let moved = false;
        const onMove = (e: MouseEvent) => {
          const dMin = snap15((e.clientX - x0) / tlPxPerMin);
          if (Math.abs(e.clientX - x0) > 3) moved = true;
          if (edge === "l") {
            el.style.left = `${origLeft + dMin * tlPxPerMin}px`;
            el.style.width = `${Math.max(15 * tlPxPerMin, origW - dMin * tlPxPerMin)}px`;
          } else if (edge === "r") {
            el.style.width = `${Math.max(15 * tlPxPerMin, origW + dMin * tlPxPerMin)}px`;
          } else {
            el.style.left = `${origLeft + dMin * tlPxPerMin}px`;
          }
        };
        const onUp = (e: MouseEvent) => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          const dMin = snap15((e.clientX - x0) / tlPxPerMin);
          if (!moved && !edge) {
            pickPhase(id);
            return;
          }
          tlKeepScroll = scEl.scrollLeft;
          if (edge === "l") patchPhaseTimes(id, Math.min(sp.s + dMin * 60000, sp.e - 15 * 60000), sp.e);
          else if (edge === "r") patchPhaseTimes(id, sp.s, Math.max(sp.e + dMin * 60000, sp.s + 15 * 60000));
          else patchPhaseTimes(id, sp.s + dMin * 60000, sp.e + dMin * 60000);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      };
      el.querySelector('[data-edge="l"]')?.addEventListener("mousedown", (e) => startDrag(e as MouseEvent, "l"));
      el.querySelector('[data-edge="r"]')?.addEventListener("mousedown", (e) => startDrag(e as MouseEvent, "r"));
      el.addEventListener("mousedown", (e) => {
        if ((e.target as HTMLElement).closest(".tl-edge, .tl-del")) return;
        startDrag(e, "");
      });
      el.querySelector<HTMLButtonElement>(".tl-del")?.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!(await confirmDialog(t("phase.confirmDelete"), { danger: true }))) return;
        await api.deletePhase(planId, id);
        removePhaseLocal(id);
      });
    });

    timelineEl.querySelector("#ph-add")?.addEventListener("click", async () => {
      const name = await promptDialog(t("phase.namePrompt"), { value: `Phase ${playerPhases().length}` });
      if (!name) return;
      const p = await api.createPhase(planId, name);
      addLocalPhase(p as PhaseT);
      if (isMB) {
        // die server-seitig gepaarte Builder-Phase nachladen
        for (const ph of await api.planPhases(planId))
          if (!phases.some((x) => x.id === ph.id)) addLocalPhase(ph as PhaseT);
      }
      selectPlayerPhase(p.id);
    });
    timelineEl.querySelector("#sub-add")?.addEventListener("click", async () => {
      const name = await promptDialog(t("mb.subPhaseName"), { value: `${playerPhases().findIndex((p) => p.id === apid) + 1}.${builderChildren(apid).length}` });
      if (!name) return;
      const p = await api.createPhase(planId, name, { plane: "builder", parent_id: apid });
      addLocalPhase(p as PhaseT);
      selectPhase(p.id);
    });

    const op = timelineEl.querySelector<HTMLInputElement>("#ph-op")!;
    const opv = timelineEl.querySelector<HTMLSpanElement>("#ph-op-v")!;
    op.addEventListener("input", () => {
      outOpacity = Number(op.value);
      opv.textContent = `${outOpacity}%`;
      localStorage.setItem("sidc_phaseopacity", String(outOpacity));
      void refreshMarkers();
      renderAnnots();
    });
    const cop = timelineEl.querySelector<HTMLInputElement>("#cross-op");
    if (cop) {
      const copv = timelineEl.querySelector<HTMLSpanElement>("#cross-op-v")!;
      cop.addEventListener("input", () => {
        crossOpacity = Number(cop.value);
        copv.textContent = `${crossOpacity}%`;
        localStorage.setItem("sidc_crossopacity", String(crossOpacity));
        void refreshMarkers();
        renderAnnots();
      });
    }
  }
  renderTimeline();

  // ── Phasen-Notizen: frei verschiebbares Fenster mit Reiter je Phase ────
  const notesWin = document.createElement("div");
  notesWin.className = "notes-win";
  notesWin.hidden = true;
  notesWin.innerHTML = `
    <div class="notes-head"><span>${t("notes.title")}</span><button class="notes-x icon-btn">${icon("x", 16)}</button></div>
    <div class="notes-tabs"></div>
    <div class="notes-times"></div>
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
  const nTimes = notesWin.querySelector<HTMLDivElement>(".notes-times")!;
  const nEdit = notesWin.querySelector<HTMLTextAreaElement>(".notes-edit")!;
  const nView = notesWin.querySelector<HTMLDivElement>(".notes-view")!;
  let notesTabId = currentPhaseId;
  let saveTimer = 0;

  const renderNotesTimes = () => {
    const ph = phases.find((p) => p.id === notesTabId);
    if (!ph) {
      nTimes.innerHTML = "";
      return;
    }
    const sp = computeSpans().get(ph.id);
    const val = (raw: string | null | undefined, fb?: number) =>
      raw ? fmtInput(parseNaive(raw)) : fb != null ? fmtInput(new Date(fb)) : "";
    nTimes.innerHTML =
      `<label>${t("phase.start")}<input type="datetime-local" data-nstart ${canEdit ? "" : "disabled"} value="${val(ph.start_at, sp?.s)}"/></label>` +
      `<label>${t("phase.end")}<input type="datetime-local" data-nend ${canEdit ? "" : "disabled"} value="${val(ph.end_at, sp?.e)}"/></label>` +
      (ph.start_at || ph.end_at
        ? `<button data-ntclear title="${t("common.reset")}">${icon("x", 12)}</button>`
        : `<span class="muted">(auto)</span>`);
    if (!canEdit) return;
    const get = (s: string) => {
      const v = nTimes.querySelector<HTMLInputElement>(s)!.value;
      return v ? parseNaive(v).getTime() : null;
    };
    const commit = () => patchPhaseTimes(ph.id, get("[data-nstart]"), get("[data-nend]"));
    nTimes.querySelector("[data-nstart]")?.addEventListener("change", commit);
    nTimes.querySelector("[data-nend]")?.addEventListener("change", commit);
    nTimes.querySelector("[data-ntclear]")?.addEventListener("click", () => patchPhaseTimes(ph.id, null, null));
  };
  repaintNotesTimes = () => {
    if (!notesWin.hidden) renderNotesTimes();
  };

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
    const tabBtn = (p: (typeof phases)[number]) =>
      `<button data-nt="${p.id}" class="${p.id === notesTabId ? "active" : ""}">${p.name}</button>`;
    const playerP = phases.filter((p) => (p.plane ?? "player") !== "builder");
    const builderP = phases.filter((p) => (p.plane ?? "player") === "builder");
    nTabs.innerHTML =
      `<div class="notes-tab-grp"><span class="notes-grp-h">${t("mb.player")}</span>${playerP.map(tabBtn).join("")}</div>` +
      (builderP.length
        ? `<div class="notes-tab-sep"></div><div class="notes-tab-grp"><span class="notes-grp-h">${t("mb.builder")}</span>${builderP.map(tabBtn).join("")}</div>`
        : "");
    nTabs.querySelectorAll<HTMLButtonElement>("[data-nt]").forEach((b) =>
      b.addEventListener("click", () => {
        flushNotes();
        notesTabId = b.dataset.nt!;
        paintNotes();
      }),
    );
    nEdit.value = ph.notes ?? "";
    nView.innerHTML = renderMarkdown(ph.notes ?? "");
    renderNotesTimes();
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
  toggleNotesWin = () => {
    notesWin.hidden = !notesWin.hidden;
    if (!notesWin.hidden) paintNotes();
  };
  {
    const si = root.querySelector<HTMLInputElement>("#mkScaleIn")!;
    const sv = root.querySelector<HTMLSpanElement>("#mkScaleV")!;
    si.addEventListener("input", () => {
      personalScale = Number(si.value) / 100 || 1;
      sv.textContent = `${si.value}%`;
      try {
        localStorage.setItem("sidc_marker_scale", String(personalScale));
      } catch {
        /* ignore */
      }
      void refreshMarkers();
    });
  }
  root.querySelector<HTMLSelectElement>("#chan")!.addEventListener("change", (e) => {
    myChannel = (e.target as HTMLSelectElement).value;
    try {
      localStorage.setItem(`sidc_channel_${planId}`, myChannel);
    } catch {
      /* ignore */
    }
    void refreshMarkers(); // Channel steuert die Sichtbarkeit fremder Marker
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
            paint: { "text-color": "#ffffff", "text-halo-color": "#000000", "text-halo-width": 2 },
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
              "text-color": "#ffffff",
              "text-halo-color": "#000000",
              "text-halo-width": 2,
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

  // Panels dürfen nicht unter die (evtl. mehrzeilige) Topbar rutschen.
  const belowTopbar = () =>
    (parseInt(getComputedStyle(root).getPropertyValue("--topbar-h")) || 48) + 6;
  // Panel rechts neben seinem (linken) Werkzeug-Knopf platzieren.
  const placeNextToTool = (panel: HTMLElement, btn: HTMLElement) => {
    const b = btn.getBoundingClientRect();
    panel.style.top = `${Math.max(belowTopbar(), b.top)}px`;
    panel.style.left = `${b.right + 8}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  };

  const layersPanel = root.querySelector<HTMLDivElement>("#layersPanel")!;
  const layersBtn = root.querySelector<HTMLButtonElement>("#layersBtn")!;
  const mvLayers = makeMovable(layersPanel, { plan: planId, key: "layers", pinnable: true });
  layersBtn.addEventListener("click", () => {
    layersPanel.hidden = !layersPanel.hidden;
    if (!layersPanel.hidden) {
      if (!mvLayers.hasPos()) placeNextToTool(layersPanel, layersBtn);
      buildLayersPanel();
      mvLayers.bringIntoView();
    }
  });
  if (mvLayers.isPinned()) {
    layersPanel.hidden = false;
    buildLayersPanel();
  }

  // ── ORBAT-Panel (Kräfteübersicht im Plan) ─────────────────────────────
  const orbatPanel = root.querySelector<HTMLDivElement>("#orbatPanel")!;
  const orbatBtn = root.querySelector<HTMLButtonElement>("#orbatBtn")!;
  const orbOpen = new Set<string>();
  let planOrbatCache: import("./api").Orbat[] = [];
  let orbatAvail: import("./api").Orbat[] = [];
  async function ensureOrbatCache(): Promise<void> {
    if (planOrbatCache.length) return;
    planOrbatCache = await api.planOrbats(planId).catch(() => []);
  }
  // Daten laden (Netz), dann rendern.
  async function refreshOrbatPanel(): Promise<void> {
    try {
      planOrbatCache = await api.planOrbats(planId);
    } catch {
      /* keine */
    }
    if (isMB) orbatAvail = await api.orbats().catch(() => []);
    renderOrbatPanel();
  }
  // Reines Rendern aus dem Cache — Baum auf-/zuklappen läuft ohne Netz.
  function renderOrbatPanel(): void {
    const linked = planOrbatCache;
    const avail = orbatAvail;
    const st = (s: string) => `<span class="st-pill st-${s}">${t("orbat.status." + s)}</span>`;
    const nodeRows = (o: import("./api").Orbat): string => {
      const ns = o.nodes ?? [];
      const kids = new Map<string, typeof ns>();
      for (const n of ns) {
        const k = n.parent_id ?? "";
        (kids.get(k) ?? kids.set(k, []).get(k)!).push(n);
      }
      const descSum = (id: string): number =>
        (kids.get(id) ?? []).reduce((a, n) => a + (n.qty_current ?? 0) + descSum(n.id), 0);
      // Alle Knoten im Teilbaum, die selbst Kinder haben (inkl. dem Knoten) — für
      // das rekursive Auf-/Zuklappen.
      const subExpandable = (id: string): string[] => {
        const ch = kids.get(id) ?? [];
        if (!ch.length) return [];
        const out = [id];
        for (const c of ch) out.push(...subExpandable(c.id));
        return out;
      };
      const rec = (pid: string, d: number): string =>
        (kids.get(pid) ?? [])
          .sort((a, b) => a.ordering - b.ordering)
          .map((n) => {
            const ch = kids.get(n.id) ?? [];
            const op = orbOpen.has(n.id);
            const sub = subExpandable(n.id);
            const subAllOpen = sub.length > 0 && sub.every((x) => orbOpen.has(x));
            return (
              `<div class="orb-row" style="margin-left:${d * 0.9}rem">` +
              (ch.length
                ? `<button class="orb-tw" data-otw="${n.id}" title="${t("orbat.toggleOne")}">${icon(op ? "chevronDown" : "chevron", 12)}</button>` +
                  `<button class="orb-tw" data-otwall="${n.id}" data-sub="${sub.join(",")}" title="${t("orbat.toggleAll")}">${icon(subAllOpen ? "minus" : "plus", 12)}</button>`
                : `<span class="orb-tw"></span>`) +
              `<span class="orb-name">${n.name}</span>` +
              `<span class="orb-qty">${n.qty_current ?? "?"}/${n.qty_planned ?? "?"}${ch.length ? ` <span class="orb-sub-sum">+${descSum(n.id)}</span>` : ""}</span>${st(n.status)}` +
              (isMB && canEdit && !o.released
                ? `<button class="icon-btn" data-oplace="${n.id}" data-osidc="${n.sidc ?? ""}" data-oname="${(n.name ?? "").replace(/"/g, "&quot;")}" title="${t("orbat.placeOnMap")}">${icon("marker", 12)}</button>`
                : "") +
              `</div>` +
              (op ? rec(n.id, d + 1) : "")
            );
          })
          .join("");
      return rec("", 0) || `<div class="muted">${t("orbat.noNodes")}</div>`;
    };
    orbatPanel.innerHTML =
      `<div class="fav-head">${t("orbat.inPlan")}</div>` +
      linked
        .map(
          (o) =>
            `<div class="orb-plan-item"><div class="row">` +
            `<span class="badge aff-${o.affiliation}">${t("orbat.aff." + o.affiliation)}</span>` +
            `<strong class="grow">${o.name}</strong>` +
            (o.released ? `<span class="muted">${t("plan.readonly")}</span>` : "") +
            (isMB ? `<button class="icon-btn" data-orm="${o.id}" title="${t("common.delete")}">${icon("x", 14)}</button>` : "") +
            `</div>${nodeRows(o)}` +
            (() => {
              const ns = o.nodes ?? [];
              const tc = ns.reduce((a, n) => a + (n.qty_current ?? 0), 0);
              const tp = ns.reduce((a, n) => a + (n.qty_planned ?? 0), 0);
              return ns.length
                ? `<div class="orb-total">${t("orbat.totalStrength")}: <strong>${tc} / ${tp}</strong></div>`
                : "";
            })() +
            `</div>`,
        )
        .join("") +
      (isMB && avail.length
        ? `<div class="row" style="margin-top:.5rem"><select id="orb-pick">${avail
            .filter((a) => !linked.some((l) => l.id === a.id))
            .map((a) => `<option value="${a.id}">${a.name}</option>`)
            .join("")}</select><button id="orb-link">${t("orbat.addToPlan")}</button></div>`
        : "") +
      (isMB ? `<a href="#/orbat" class="muted">${t("nav.orbat")} →</a>` : "");

    orbatPanel.querySelectorAll<HTMLButtonElement>("[data-otw]").forEach((b) =>
      b.addEventListener("click", () => {
        const id = b.dataset.otw!;
        orbOpen.has(id) ? orbOpen.delete(id) : orbOpen.add(id);
        renderOrbatPanel(); // rein lokal — kein Netz
      }),
    );
    orbatPanel.querySelectorAll<HTMLButtonElement>("[data-otwall]").forEach((b) =>
      b.addEventListener("click", () => {
        const ids = (b.dataset.sub || "").split(",").filter(Boolean);
        const allOpen = ids.every((x) => orbOpen.has(x));
        ids.forEach((x) => (allOpen ? orbOpen.delete(x) : orbOpen.add(x)));
        renderOrbatPanel();
      }),
    );
    orbatPanel.querySelectorAll<HTMLButtonElement>("[data-orm]").forEach((b) =>
      b.addEventListener("click", async () => {
        await api.removePlanOrbat(planId, b.dataset.orm!).catch(() => {});
        void refreshOrbatPanel();
      }),
    );
    orbatPanel.querySelectorAll<HTMLButtonElement>("[data-oplace]").forEach((b) =>
      b.addEventListener("click", () => {
        chainGroup = null;
        awaitingPos = false;
        pending = {
          sidc: b.dataset.osidc || "10060000000000000000",
          unit_text: b.dataset.oname || "",
          ai_text: "",
          channel: myChannel,
          locked: false,
          timestamp_visible: true,
          rotation_degrees: -1,
          is_multipoint: false,
          max_line_points: 0,
          orbat_node_id: b.dataset.oplace!,
          orbat_strength: 1,
        };
        setMode("place");
        orbatPanel.hidden = true;
      }),
    );
    orbatPanel.querySelector("#orb-link")?.addEventListener("click", async () => {
      const id = orbatPanel.querySelector<HTMLSelectElement>("#orb-pick")!.value;
      if (id) {
        await api.addPlanOrbat(planId, id).catch(toastError);
        void refreshOrbatPanel();
      }
    });
  }
  const mvOrbat = makeMovable(orbatPanel, { plan: planId, key: "orbat", pinnable: true });
  orbatBtn.addEventListener("click", () => {
    orbatPanel.hidden = !orbatPanel.hidden;
    if (!orbatPanel.hidden) {
      if (!mvOrbat.hasPos()) placeNextToTool(orbatPanel, orbatBtn);
      if (planOrbatCache.length) renderOrbatPanel(); // sofort aus Cache
      else orbatPanel.innerHTML = `<div class="fav-head">${t("orbat.inPlan")}</div><div class="muted">…</div>`;
      void refreshOrbatPanel();
      mvOrbat.bringIntoView();
    }
  });
  if (mvOrbat.isPinned()) {
    orbatPanel.hidden = false;
    void refreshOrbatPanel();
  }

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
        ? `<input type="range" min="0" max="100" step="5" value="${Math.round(opac(name) * 100)}" data-op="${name}" title="${t("layers.opacityHint")}"/>`
        : "";
      rows.push(
        `<div class="layer-row"><label><input type="checkbox" data-base="${name}" ${on ? "checked" : ""}/> ${label}</label>${slider}</div>`,
      );
    }

    if (locData) {
      rows.push(`<div class="fav-head">${t('layers.places')}</div>`);
      rows.push(
        `<div class="layer-row"><label>${t("layers.opacity")}</label><input type="range" min="0" max="100" step="5" value="${Math.round(opac("locations") * 100)}" data-op="locations" title="${t("layers.opacityHint")}"/></div>`,
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
  makeMovable(toolbar, { plan: planId, key: "toolbar" });
  const lineStylePanel = root.querySelector<HTMLDivElement>("#lineStyle")!;
  const mvLine = makeMovable(lineStylePanel, { plan: planId, key: "linestyle", pinnable: true });
  let linePts: [number, number][] = [];
  let linePhaseId: string | null = currentPhaseId || null;
  let lineChannel = myChannel;
  let chainGroup: number | null = null;
  let chainIndex = 0;
  // Marker-Workflow wie im ATAK: erst Position auf der Karte klicken, dann öffnet
  // sich der Wizard. awaitingPos = warte auf den Positions-Klick.
  let awaitingPos = false;
  let pendingPos: [number, number] | null = null;

  const lineDoneBtn = root.querySelector<HTMLButtonElement>("#lineDone")!;
  const strokeGearBtn = root.querySelector<HTMLButtonElement>("#strokeGear")!;
  // Anker für den grünen Haken (und das Zahnrad): letzter Punkt der laufenden
  // Linie bzw. der gerade bearbeiteten Linie/Messlinie.
  const doneAnchor = (): [number, number] | null => {
    if (mode === "line" && linePts.length >= 2) return linePts[linePts.length - 1];
    if (editStrokeId) {
      const p = strokes.get(editStrokeId)?.points;
      if (p && p.length) return p[p.length - 1] as [number, number];
    }
    if (editMeasureId) {
      const p = measureLines.find((x) => x.id === editMeasureId)?.pts;
      if (p && p.length) return p[p.length - 1];
    }
    return null;
  };
  const positionLineDone = () => {
    const a = doneAnchor();
    // Zahnrad nur beim Bearbeiten einer bestehenden Phasenlinie
    const showGear = !!editStrokeId && mode !== "line";
    if (!a) {
      lineDoneBtn.hidden = true;
      strokeGearBtn.hidden = true;
      return;
    }
    const p = map.project(a);
    // #map ist um die Topbar-Höhe nach unten versetzt — die Buttons liegen in
    // #app, also den Versatz addieren (fester Bildschirm-Abstand, skaliert nicht).
    const mr = map.getContainer().getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    const bx = mr.left - rr.left + p.x;
    const by = mr.top - rr.top + p.y;
    lineDoneBtn.hidden = false;
    lineDoneBtn.style.left = `${Math.round(bx - 16)}px`;
    lineDoneBtn.style.top = `${Math.round(by - 46)}px`;
    strokeGearBtn.hidden = !showGear;
    if (showGear) {
      strokeGearBtn.style.left = `${Math.round(bx + 22)}px`;
      strokeGearBtn.style.top = `${Math.round(by - 46)}px`;
    }
  };
  onEditSelChange = positionLineDone;
  lineDoneBtn.addEventListener("click", () => {
    if (mode === "line") finishLine();
    else if (editStrokeId) setEditStroke(null);
    else if (editMeasureId) setEditMeasure(null);
  });
  strokeGearBtn.addEventListener("click", () => {
    if (editStrokeId) openStrokeSettings(editStrokeId);
  });
  const refreshLineDraft = () => {
    (map.getSource("linedraft") as GeoJSONSource)?.setData(lineDraftFC(linePts));
    positionLineDone();
  };

  const fmtDist = (mtr: number) => (mtr < 1000 ? `${Math.round(mtr)} m` : `${(mtr / 1000).toFixed(2)} km`);
  const pathLen = (pts: [number, number][]): number => {
    let s = 0;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = lngLatToWorld(cal, pts[i - 1][0], pts[i - 1][1]);
      const [bx, by] = lngLatToWorld(cal, pts[i][0], pts[i][1]);
      s += Math.hypot(bx - ax, by - ay);
    }
    return s;
  };
  const redrawMeasure = () => {
    const src = map.getSource("measure") as GeoJSONSource | undefined;
    if (!src) return;
    const feats: GeoJSON.Feature[] = [];
    // Alle Messlinien gestrichelt (wie die Vorschau). Zwischen je zwei Punkten die
    // Teilstrecke, am Ende zusätzlich die Gesamtstrecke.
    const addLine = (id: string, pts: [number, number][]) => {
      if (pts.length >= 2)
        feats.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: pts },
          properties: { kind: "line", mid: id, dashed: true },
        });
      for (const p of pts)
        feats.push({ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: { kind: "pt", mid: id } });
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        feats.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] },
          properties: { kind: "label", label: fmtDist(pathLen([a, b])) },
        });
      }
      if (pts.length >= 3)
        feats.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: pts[pts.length - 1] },
          properties: { kind: "label", label: `Σ ${fmtDist(pathLen(pts))}` },
        });
    };
    const curBuilder = isBuilderPhase(currentPhaseId);
    for (const ml of measureLines) if (ml.builder === curBuilder) addLine(ml.id, ml.pts);
    if (measureActive.length) {
      const live = measureCursor ? [...measureActive, measureCursor] : measureActive;
      addLine("__active", live);
    }
    src.setData({ type: "FeatureCollection", features: feats });
  };
  const commitMeasure = () => {
    if (measureActive.length >= 2)
      measureLines.push({
        id: `m${Date.now()}`,
        pts: [...measureActive],
        builder: isBuilderPhase(currentPhaseId),
      });
    measureActive = [];
    measureCursor = null;
    redrawMeasure();
  };

  const modeCursor = (m: Mode = mode): string =>
    m === "place" || m === "line" || m === "point" || m === "measure" || m === "text"
      ? "crosshair"
      : m === "erase"
        ? "not-allowed"
        : m === "markermove"
          ? "move"
          : "";
  const setMode = (m: Mode) => {
    mode = m;
    toolbar.querySelectorAll("[data-mode]").forEach((b) =>
      b.classList.toggle("active", (b as HTMLElement).dataset.mode === m),
    );
    map.getCanvas().style.cursor = modeCursor(m);
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
    lineStylePanel.hidden = mvLine.isPinned() ? false : m !== "line";
    if (m === "line") {
      linePhaseId = currentPhaseId || null;
      const lp = root.querySelector<HTMLSelectElement>("#lPhase");
      if (lp) lp.value = linePhaseId ?? "";
    }
    if (m !== "line") {
      linePts = [];
      refreshLineDraft();
    }
    if (m !== "move" && m !== "markermove") setEditStroke(null);
    if (m !== "measure") {
      measureActive = [];
      measureCursor = null;
      redrawMeasure();
    }
    if (m !== "move" && m !== "markermove") setEditMeasure(null);
    if (m !== "point" && peers.has(me.id)) {
      peers.delete(me.id);
      refreshPeers();
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

  root.querySelector("#settingsBtn")!.addEventListener("click", openSettings);

  // Tastenkürzel für die Werkzeug-Modi (im Einstellungs-Menü umbelegbar).
  const onModeKey = (ev: KeyboardEvent) => {
    if (!canEdit) return;
    const m = modeForKey(ev);
    if (!m) return;
    if (m === "place" || m === "fav") {
      const b = toolbar.querySelector<HTMLButtonElement>(m === "place" ? "#tool-marker" : "#tool-fav");
      if (b && !b.disabled) b.click();
      return;
    }
    const b = toolbar.querySelector<HTMLButtonElement>(`[data-mode="${m}"]`);
    if (b && !b.disabled) setMode(m);
  };
  document.addEventListener("keydown", onModeKey);
  window.addEventListener("hashchange", () => document.removeEventListener("keydown", onModeKey), {
    once: true,
  });

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
    if (tpl.orbat_node_id) {
      data.orbat_node_id = tpl.orbat_node_id;
      data.orbat_strength = tpl.orbat_strength ?? 1;
    }
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
  {
    const lp = root.querySelector<HTMLSelectElement>("#lPhase")!;
    const lc = root.querySelector<HTMLSelectElement>("#lChan")!;
    lp.value = linePhaseId ?? "";
    lc.value = lineChannel;
    lp.addEventListener("change", () => (linePhaseId = lp.value || null));
    lc.addEventListener("change", () => (lineChannel = lc.value));
  }
  const finishLine = () => {
    if (linePts.length >= 2) {
      socket.send({
        type: "stroke.commit",
        cid: cid(),
        data: {
          kind: "phaseline",
          points: linePts,
          color: lineColor,
          width: lineWidth,
          phase_id: linePhaseId,
          channel: lineChannel,
        },
      });
    }
    linePts = [];
    refreshLineDraft();
  };
  root.querySelector("#lineFinish")!.addEventListener("click", finishLine);
  // Laufende Linie verwerfen (Rechtsklick / Escape) — ohne sie zu setzen.
  const cancelLine = () => {
    linePts = [];
    refreshLineDraft();
  };

  // Zahnrad an einer bestehenden Phasenlinie: Phase/Ebene, Channel, Farbe, Breite
  function openStrokeSettings(strokeId: string): void {
    const s = strokes.get(strokeId);
    if (!s) return;
    const back = document.createElement("div");
    back.className = "edit-modal";
    back.innerHTML = `<div class="card" style="width:min(24rem,96vw)">
      <div class="row"><h1 style="flex:1;margin:0">${t("line.edit")}</h1><button class="icon-btn" data-x>${icon("x")}</button></div>
      <label class="chk-lbl">${t("phase.assign")}
        <select data-sphase>
          <option value="">${t("phase.global")}</option>
          ${phases
            .map(
              (ph) =>
                `<option value="${ph.id}" ${ph.id === s.phase_id ? "selected" : ""}>${ph.plane === "builder" ? "⚑ " : ""}${ph.name}</option>`,
            )
            .join("")}
        </select></label>
      <label class="chk-lbl">${t("wiz.channel")}
        <select data-schan>${(channels?.channels ?? [])
          .map((c) => `<option value="${c.name}" ${c.name === (s.channel || "") ? "selected" : ""}>${channelLabel(c)}</option>`)
          .join("")}</select></label>
      <label class="chk-lbl">${t("line.color")}
        <select data-scolor>${lineColors
          .map((c) => `<option value="${c.packedColor}" ${c.packedColor === s.color ? "selected" : ""}>${c.name}</option>`)
          .join("")}</select></label>
      <label class="chk-lbl">${t("line.width")}
        <select data-swidth>${lineWidths
          .map((w) => `<option value="${w.width}" ${w.width === s.width ? "selected" : ""}>${w.width}</option>`)
          .join("")}</select></label>
      <div class="row" style="margin-top:.6rem"><button class="primary" data-save style="flex:1">${t("common.save")}</button></div>
    </div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.addEventListener("mousedown", (e) => e.target === back && close());
    back.querySelector("[data-x]")!.addEventListener("click", close);
    back.querySelector("[data-save]")!.addEventListener("click", () => {
      socket.send({
        type: "stroke.modify",
        id: strokeId,
        data: {
          phase_id: back.querySelector<HTMLSelectElement>("[data-sphase]")!.value || null,
          channel: back.querySelector<HTMLSelectElement>("[data-schan]")!.value,
          color: Number(back.querySelector<HTMLSelectElement>("[data-scolor]")!.value),
          width: Number(back.querySelector<HTMLSelectElement>("[data-swidth]")!.value),
        },
      });
      close();
    });
  }

  function applyCaps(): void {
    const tb = root.querySelector("#toolbar");
    if (!tb) return;
    tb.querySelector<HTMLButtonElement>('[data-mode="line"]')?.toggleAttribute("disabled", !caps.draw);
    tb.querySelector<HTMLButtonElement>('[data-mode="markermove"]')?.toggleAttribute("disabled", !caps.move);
    tb.querySelector<HTMLButtonElement>('[data-mode="erase"]')?.toggleAttribute("disabled", !caps.delete);
    tb.querySelector<HTMLButtonElement>('[data-mode="text"]')?.toggleAttribute("disabled", !caps.place);
    tb.querySelector<HTMLButtonElement>("#tool-marker")?.toggleAttribute("disabled", !caps.place);
    tb.querySelector<HTMLButtonElement>("#tool-fav")?.toggleAttribute("disabled", !caps.place);
  }
  applyCaps();

  // ── Favoriten ─────────────────────────────────────────────────────────
  const favPanel = root.querySelector<HTMLDivElement>("#favPanel")!;
  const mvFav = makeMovable(favPanel, { plan: planId, key: "fav", pinnable: true });
  if (mvFav.isPinned()) favPanel.hidden = false;
  let favs = await api.favorites();
  const renderFavs = () => {
    favPanel.innerHTML =
      `<div class="fav-head">${t("fav.heading")}</div>` +
      (favs.length
        ? favs
            .map(
              (f) => `<div class="fav" data-fav="${f.id}">
                <img src="${iconSrc(f.sidc)}" width="24" height="24" onerror="this.style.visibility='hidden'"/>
                <span>${f.label}</span><button class="icon-btn" data-delfav="${f.id}">${icon("x", 14)}</button></div>`,
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
          channel: f.channel || myChannel,
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
  root.querySelector("#tool-fav")!.addEventListener("click", () => {
    favPanel.hidden = !favPanel.hidden;
    if (!favPanel.hidden) {
      if (!mvFav.hasPos()) {
        const b = (root.querySelector("#tool-fav") as HTMLElement).getBoundingClientRect();
        favPanel.style.top = `${Math.max(b.top, belowTopbar())}px`;
        favPanel.style.left = `${b.right + 6}px`;
        favPanel.style.right = "auto";
      }
      mvFav.bringIntoView();
    }
  });

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
    if (m.released) return; // freigegebene Feind-Marker sind nur Anzeige
    if (mode === "erase") {
      if (caps.delete) socket.send({ type: "marker.delete", id: m.id });
    } else if (mode === "move" || mode === "markermove") {
      openEditPanel(m);
    }
  };
  map.on("click", "marker-icon", onMarkerClick);
  map.on("click", "marker-dot", onMarkerClick); // Marker ohne PNG-Icon klickbar halten

  // Marker ziehen (siehe unten) — früh deklariert, weil der Hover-Handler prüft.
  let dragId: string | null = null;

  // Linie zum Bearbeiten wählen (Verschieben-Modus), Stützpunkte ziehen
  map.on("click", "strokes", (e) => {
    if (!canEdit || (mode !== "move" && mode !== "markermove")) return;
    e.preventDefault();
    setEditStroke((e.features?.[0]?.properties?.id as string) ?? null);
  });
  map.on("click", "measure-line", (e) => {
    if (mode === "erase") {
      e.preventDefault();
      const mid = e.features?.[0]?.properties?.mid as string | undefined;
      if (mid && mid !== "__active") {
        measureLines = measureLines.filter((x) => x.id !== mid);
        if (editMeasureId === mid) setEditMeasure(null);
        redrawMeasure();
      }
      return;
    }
    if (mode !== "move" && mode !== "markermove") return;
    e.preventDefault();
    const mid = e.features?.[0]?.properties?.mid as string | undefined;
    setEditMeasure(mid && mid !== "__active" ? mid : null);
  });
  map.on("mouseenter", "strokeverts", () => (map.getCanvas().style.cursor = "grab"));
  map.on("mouseleave", "strokeverts", () => (map.getCanvas().style.cursor = modeCursor()));
  map.on("mousedown", "strokeverts", (e) => {
    const idx = e.features?.[0]?.properties?.i as number;
    const pts = editPts();
    if (!pts || idx == null) return;
    e.preventDefault();
    map.dragPan.disable();
    map.getCanvas().style.cursor = "grabbing";
    const onMove = (ev: maplibregl.MapMouseEvent) => {
      pts[idx] = [ev.lngLat.lng, ev.lngLat.lat];
      if (editStrokeId) refreshStrokes();
      else redrawMeasure();
      refreshStrokeVerts();
    };
    const onUp = () => {
      map.off("mousemove", onMove);
      map.dragPan.enable();
      map.getCanvas().style.cursor = modeCursor();
      if (editStrokeId) socket.send({ type: "stroke.modify", id: editStrokeId, data: { points: pts } });
    };
    map.on("mousemove", onMove);
    map.once("mouseup", onUp);
  });

  // Hover: Channel / Ersteller / Phase des Markers
  const hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14 });
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const showHover = (e: maplibregl.MapLayerMouseEvent) => {
    if (dragId) return;
    const id = e.features?.[0]?.properties?.id as string | undefined;
    const m = id ? markers.get(id) : undefined;
    if (!m) return;
    map.getCanvas().style.cursor = "pointer";
    const info = markerInfoText(m.sidc);
    hoverPopup
      .setLngLat([m.world_x, m.world_y])
      .setHTML(
        `<div class="mk-tip"><b>${esc(markerLabel(m) || "—")}</b><br>` +
          `${t("map.channel")}: ${esc(m.channel || "—")}<br>` +
          `${t("marker.author")}: ${esc(m.author || "—")}<br>` +
          `${t("phase.assign")}: ${esc(phaseNameOf(m.phase_id))}` +
          (info ? `<div class="mk-tip-info">${esc(info)}</div>` : "") +
          `</div>`,
      )
      .addTo(map);
  };
  const hideHover = () => {
    map.getCanvas().style.cursor = modeCursor(); // nicht hart auf Default zurück
    hoverPopup.remove();
  };
  for (const ly of ["marker-icon", "marker-dot"]) {
    map.on("mouseenter", ly, showHover);
    map.on("mouseleave", ly, hideHover);
  }

  // Marker ziehen: im Modus "markermove" (linke Taste) ODER im Karten-Modus mit
  // gehaltener mittlerer Maustaste.
  const onMarkerMouseDown = (e: maplibregl.MapLayerMouseEvent) => {
    const midBtn = e.originalEvent.button === 1;
    const wantDrag = caps.move && (mode === "markermove" || (mode === "move" && midBtn));
    if (!wantDrag) return;
    const id = e.features?.[0]?.properties?.id as string;
    const m = id ? markers.get(id) : undefined;
    if (!m || m.locked) return;
    e.preventDefault();
    e.originalEvent.preventDefault(); // Mittelklick-Autoscroll unterdrücken
    const dragFromX = m.world_x;
    const dragFromY = m.world_y;
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
      map.getCanvas().style.cursor = modeCursor();
      if (finished) {
        const ax = ev.lngLat.lng;
        const ay = ev.lngLat.lat;
        socket.send({ type: "marker.move", id: finished, world_x: ax, world_y: ay });
        pushCmd({
          undo: () => socket.send({ type: "marker.move", id: finished, world_x: dragFromX, world_y: dragFromY }),
          redo: () => socket.send({ type: "marker.move", id: finished, world_x: ax, world_y: ay }),
        });
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

  // Rechtsklick bricht ab: Linien-Bearbeiten / laufende Linie / Marker-Linie
  map.on("contextmenu", (e) => {
    if (editStrokeId || editMeasureId) {
      e.preventDefault();
      setEditStroke(null);
      setEditMeasure(null); // Bearbeiten abbrechen
    } else if (mode === "line" && linePts.length) {
      e.preventDefault();
      cancelLine(); // laufende Linie verwerfen, NICHT setzen
    } else if (mode === "measure") {
      e.preventDefault();
      commitMeasure(); // Rechtsklick: Messlinie festhalten …
      setMode("move"); // … und zurück zum Karten-Ziehen
    } else if (mode === "place" && chainGroup != null && chainIndex > 0) {
      e.preventDefault();
      setMode("move");
    }
  });

  // ── Annotationen (platzierbare Markdown-Textfelder) ───────────────────
  const annotsEl = root.querySelector<HTMLDivElement>("#annots")!;
  let annotDragId: string | null = null;
  let annotResizingId: string | null = null;
  let pendingAnnotCid: string | null = null;
  const annotOpacity = (a: Annot): number => phaseOpacityOf(a.phase_id);
  const ANNOT_COLL_KEY = `sidc_annot_coll_${planId}`;
  const collapsedAnnots = new Set<string>(
    (() => {
      try {
        return JSON.parse(localStorage.getItem(ANNOT_COLL_KEY) || "[]");
      } catch {
        return [];
      }
    })(),
  );
  const saveCollapsed = () => {
    try {
      localStorage.setItem(ANNOT_COLL_KEY, JSON.stringify([...collapsedAnnots]));
    } catch {
      /* ignore */
    }
  };
  const annotFirstLine = (s: string): string =>
    (s.split("\n").find((l) => l.trim()) ?? "").replace(/^#{1,6}\s+/, "").trim() || t("annot.placeholder");
  // Referenz-Zoom für Notizen ohne eigenen ref_zoom (Altbestand): der Zoom beim
  // ersten Zeichnen der Notizen — so skalieren sie ab jetzt mit der Karte mit.
  let annotRefFallback = 0;
  // scale_fixed === true  → Notiz skaliert MIT der Karte (zoomt mit)
  // scale_fixed === false → konstante Bildschirmgröße (Standard)
  const annotScale = (a: Annot): number => {
    if (!a.scale_fixed) return 1;
    const ref = a.ref_zoom && a.ref_zoom > 0 ? a.ref_zoom : annotRefFallback;
    if (!ref) return 1;
    return Math.max(0.3, Math.min(3, 2 ** (map.getZoom() - ref)));
  };

  function positionAnnots(): void {
    for (const el of Array.from(annotsEl.children) as HTMLElement[]) {
      const a = annots.get(el.dataset.aid ?? "");
      if (!a) continue;
      const p = map.project([a.world_x, a.world_y]);
      el.style.transform = `translate(${p.x}px, ${p.y}px) scale(${annotScale(a)})`;
    }
  }

  function openAnnotEditor(id: string, isNew = false): void {
    const a = annots.get(id);
    if (!a || !canEdit) return;
    const back = document.createElement("div");
    back.className = "edit-modal";
    back.innerHTML = `<div class="card" style="width:min(34rem,96vw)">
      <div class="row"><h1 style="flex:1;margin:0">${t("annot.title")}</h1><button class="icon-btn" data-x>${icon("x")}</button></div>
      <textarea class="notes-edit annot-edit" rows="6" placeholder="${t("annot.hint")}"></textarea>
      <label style="margin-top:.4rem">${t("phase.assign")}</label>
      <select data-aphase>
        <option value="">${t("phase.global")}</option>
        ${phases
          .map(
            (ph) =>
              `<option value="${ph.id}" ${ph.id === a.phase_id ? "selected" : ""}>${ph.plane === "builder" ? "⚑ " : ""}${ph.name}</option>`,
          )
          .join("")}
      </select>
      <label class="ph-op" style="margin-top:.4rem">${t("annot.width")}
        <input type="range" min="140" max="480" step="10" value="${a.width}" data-w /></label>
      <label class="chk" style="margin-top:.3rem"><input type="checkbox" data-fix ${a.scale_fixed ? "checked" : ""}/> <span>${t("annot.scaleWithMap")}</span></label>
      <p class="muted" style="margin:.2rem 0 0;font-size:.75rem">${t("annot.resizeHint")}</p>
      <div class="notes-view annot-prev"></div>
      <div class="row" style="margin-top:.6rem">
        <button class="primary" data-save style="flex:1">${t("common.save")}</button>
        <button class="danger" data-del>${t("common.delete")}</button>
      </div>
    </div>`;
    document.body.appendChild(back);
    const ta = back.querySelector<HTMLTextAreaElement>(".annot-edit")!;
    ta.value = a.text;
    const prev = back.querySelector<HTMLDivElement>(".annot-prev")!;
    const wIn = back.querySelector<HTMLInputElement>("[data-w]")!;
    const fixIn = back.querySelector<HTMLInputElement>("[data-fix]")!;
    const upd = () => (prev.innerHTML = renderMarkdown(ta.value));
    ta.addEventListener("input", upd);
    upd();
    setTimeout(() => ta.focus(), 0);
    const removeIfEmpty = () => {
      if (isNew && !ta.value.trim()) socket.send({ type: "annotation.delete", id });
    };
    const close = () => {
      removeIfEmpty();
      back.remove();
    };
    back.addEventListener("mousedown", (e) => e.target === back && close());
    back.querySelector("[data-x]")!.addEventListener("click", close);
    back.querySelector("[data-save]")!.addEventListener("click", () => {
      const text = ta.value.trim();
      if (!text) {
        socket.send({ type: "annotation.delete", id }); // leere Notiz nicht speichern
        back.remove();
        return;
      }
      const wantScale = fixIn.checked; // true = mit der Karte mitskalieren
      const sc = annotScale(a);
      const phaseSel = back.querySelector<HTMLSelectElement>("[data-aphase]")!;
      const data: Record<string, unknown> = {
        text: ta.value,
        // Wird das Mitskalieren abgeschaltet, aktuelle Bildschirmgröße einfrieren:
        width:
          !wantScale && a.scale_fixed
            ? Math.round(Number(wIn.value) * sc)
            : Number(wIn.value),
        height:
          !wantScale && a.scale_fixed && a.height ? Math.round(a.height * sc) : a.height ?? 0,
        phase_id: phaseSel.value || null,
        scale_fixed: wantScale,
      };
      if (wantScale && (!a.scale_fixed || !a.ref_zoom || a.ref_zoom <= 0))
        data.ref_zoom = map.getZoom(); // aktuelle Größe = natürliche Größe
      socket.send({ type: "annotation.modify", id, data });
      back.remove();
    });
    back.querySelector("[data-del]")!.addEventListener("click", () => {
      socket.send({ type: "annotation.delete", id });
      back.remove();
    });
  }

  function onAnnotDown(ev: MouseEvent, id: string): void {
    if (!canEdit || (mode !== "move" && mode !== "markermove")) return;
    if ((ev.target as HTMLElement).closest(".annot-tools")) return;
    // Untere rechte Ecke = CSS-resize-Griff → Browser die Größenänderung machen
    // lassen und erst beim Loslassen synchronisieren (kein Neuaufbau währenddessen).
    const el0 = annotsEl.querySelector<HTMLElement>(`[data-aid="${id}"]`);
    if (el0) {
      const a0 = annots.get(id);
      const sc = a0 ? annotScale(a0) || 1 : 1;
      const r = el0.getBoundingClientRect();
      const lx = (ev.clientX - r.left) / sc;
      const ly = (ev.clientY - r.top) / sc;
      if (lx > el0.clientWidth - 22 && ly > el0.clientHeight - 22) {
        if (!canEdit) return;
        annotResizingId = id;
        const finish = () => {
          document.removeEventListener("mouseup", finish);
          if (annotResizingId !== id) return;
          annotResizingId = null;
          const cur = annots.get(id);
          if (cur) {
            const w = Math.round(el0.offsetWidth);
            const h = Math.round(el0.offsetHeight);
            if (Math.abs(w - cur.width) > 2 || Math.abs(h - (cur.height ?? 0)) > 2) {
              cur.width = w;
              cur.height = h;
              socket.send({
                type: "annotation.modify",
                id,
                data: { width: w, height: h, phase_id: cur.phase_id },
              });
            }
          }
          renderAnnots();
        };
        document.addEventListener("mouseup", finish);
        return; // nativen Resize laufen lassen
      }
    }
    ev.stopPropagation();
    ev.preventDefault();
    annotDragId = id;
    const el = annotsEl.querySelector<HTMLElement>(`[data-aid="${id}"]`)!;
    el.classList.add("dragging");
    if (mode === "move") map.dragPan.disable();
    const canvasRect = () => map.getCanvas().getBoundingClientRect();
    const onMove = (e: MouseEvent) => {
      const r = canvasRect();
      const ll = map.unproject([e.clientX - r.left, e.clientY - r.top]);
      const a = annots.get(id);
      if (a) {
        a.world_x = ll.lng;
        a.world_y = ll.lat;
        positionAnnots();
      }
    };
    const onUp = (e: MouseEvent) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      el.classList.remove("dragging");
      if (mode === "move") map.dragPan.enable();
      annotDragId = null;
      const r = canvasRect();
      const ll = map.unproject([e.clientX - r.left, e.clientY - r.top]);
      socket.send({ type: "annotation.move", id, data: { world_x: ll.lng, world_y: ll.lat } });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function renderAnnots(): void {
    if (annotResizingId) return; // Neuaufbau würde das laufende Ziehen abbrechen
    if (!annotRefFallback) annotRefFallback = map.getZoom();
    annotsEl.innerHTML = "";
    for (const a of annots.values()) {
      const collapsed = collapsedAnnots.has(a.id);
      const el = document.createElement("div");
      el.className = "annot" + (collapsed ? " annot-collapsed" : "");
      el.dataset.aid = a.id;
      el.style.width = `${a.width}px`;
      if (a.height && !collapsed) el.style.height = `${a.height}px`;
      else el.style.height = "";
      el.style.opacity = String(annotOpacity(a));
      const body = collapsed
        ? `<div class="annot-body">${esc(annotFirstLine(a.text))}</div>`
        : `<div class="annot-body">${renderMarkdown(a.text || "")}</div>`;
      el.innerHTML =
        body +
        `<div class="annot-tools">` +
        `<button class="icon-btn" data-acoll title="${t(collapsed ? "annot.expand" : "annot.collapse")}">${icon(collapsed ? "chevron" : "chevronDown", 14)}</button>` +
        (canEdit
          ? `<button class="icon-btn" data-aedit title="${t("common.rename")}">${icon("edit", 14)}</button>` +
            `<button class="icon-btn" data-adel title="${t("common.delete")}">${icon("x", 14)}</button>`
          : "") +
        `</div>`;
      el.querySelector("[data-acoll]")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        collapsed ? collapsedAnnots.delete(a.id) : collapsedAnnots.add(a.id);
        saveCollapsed();
        renderAnnots();
      });
      el.querySelector("[data-aedit]")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openAnnotEditor(a.id);
      });
      el.querySelector("[data-adel]")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const tools = el.querySelector<HTMLElement>(".annot-tools")!;
        tools.innerHTML = `<label class="annot-delok"><input type="checkbox" data-adok/> ${t("common.delete")}</label>`;
        tools.querySelector("[data-adok]")!.addEventListener("change", () =>
          socket.send({ type: "annotation.delete", id: a.id }),
        );
      });
      el.addEventListener("mousedown", (ev) => onAnnotDown(ev, a.id));
      el.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        openAnnotEditor(a.id);
      });
      annotsEl.appendChild(el);
    }
    positionAnnots();
  }

  map.on("move", () => {
    if (!annotDragId && !annotResizingId) positionAnnots();
    positionLineDone();
  });
  map.on("zoomend", () => (map.getSource("chains") as GeoJSONSource)?.setData(chainFC()));
  phaseListeners.push(() => renderAnnots());
  phaseListeners.push(() => redrawMeasure()); // Messlinien: Ebene (Missionsbau/Spieler)
  renderAnnots();

  map.on("click", (e) => {
    if ((e as { defaultPrevented?: boolean }).defaultPrevented) return;

    // Klick ins Leere beendet das Bearbeiten einer Linie/Messlinie
    if ((mode === "move" || mode === "markermove") && (editStrokeId || editMeasureId)) {
      setEditStroke(null);
      setEditMeasure(null);
      return;
    }

    if (mode === "text") {
      if (!caps.place) return;
      const ac = cid();
      pendingAnnotCid = ac; // Antwort öffnet direkt den Editor
      socket.send({
        type: "annotation.create",
        cid: ac,
        data: {
          world_x: e.lngLat.lng,
          world_y: e.lngLat.lat,
          text: "",
          width: 220,
          phase_id: currentPhaseId || null,
          ref_zoom: map.getZoom(),
        },
      });
      setMode("move");
      return;
    }

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
      measureActive.push([e.lngLat.lng, e.lngLat.lat]); // Linksklick verlängert
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
        }, myChannel);
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
      if (mode === "line" && linePts.length) cancelLine();
      else if (editStrokeId || editMeasureId) {
        setEditStroke(null);
        setEditMeasure(null);
      } else setMode("move");
    }
  });

  // ── Marker-Edit-Panel (zentriertes Fenster, Klick außerhalb schließt) ──
  async function openEditPanel(m: Marker): Promise<void> {
    root.querySelector("#editModal")?.remove();
    if (isMB) await ensureOrbatCache();
    const orbatNodeOpts = isMB
      ? planOrbatCache
          .flatMap((o) => (o.nodes ?? []).map((n) => ({ id: n.id, label: `${o.name} · ${n.name}` })))
      : [];
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
      <label class="ph-op">${t("marker.scale")}
        <input type="range" min="25" max="300" step="5" data-mscale value="${Math.round((m.scale ?? 1) * 100)}" />
        <span data-mscalev>${Math.round((m.scale ?? 1) * 100)}%</span></label>
      <label>${t("phase.assign")}</label>
      <select data-phase>
        <option value="">${t("phase.global")}</option>
        ${phases
          .map(
            (ph) =>
              `<option value="${ph.id}" ${ph.id === m.phase_id ? "selected" : ""}>${ph.plane === "builder" ? "⚑ " : ""}${ph.name}</option>`,
          )
          .join("")}
      </select>
      <label>${t("wiz.channel")}</label>
      <select data-chan>${(channels?.channels ?? [])
        .map((c) => `<option value="${c.name}" ${c.name === m.channel ? "selected" : ""}>${channelLabel(c)}</option>`)
        .join("")}</select>
      <label class="chk"><input type="checkbox" data-lock ${m.locked ? "checked" : ""}/> <span>${t("marker.locked")}</span></label>
      ${
        isMB
          ? `<label>${t("orbat.nodeLink")}</label>
             <select data-onode>
               <option value="">${t("orbat.nodeNone")}</option>
               ${orbatNodeOpts
                 .map((o) => `<option value="${o.id}" ${o.id === m.orbat_node_id ? "selected" : ""}>${o.label}</option>`)
                 .join("")}
             </select>
             <label>${t("orbat.markerStrength")}</label>
             <input data-ostr type="number" min="1" value="${m.orbat_strength ?? 1}" />`
          : ""
      }
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
        // 0 = "kein Modifikator" muss die SIDC-Stelle aktiv zurücksetzen, nicht ignorieren
        s[sel.dataset.mod as keyof SidcModifiers] = Number(sel.value) || 0;
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
    {
      const ms = p.querySelector<HTMLInputElement>("[data-mscale]")!;
      const mv = p.querySelector<HTMLSpanElement>("[data-mscalev]")!;
      ms.addEventListener("input", () => (mv.textContent = `${ms.value}%`));
    }
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
      const data: Record<string, unknown> = {
        unit_text: p.querySelector<HTMLInputElement>("[data-unit]")!.value,
        ai_text: p.querySelector<HTMLInputElement>("[data-ai]")!.value,
        icon_rotation: Number(p.querySelector<HTMLInputElement>("[data-rot]")!.value) || 0,
        phase_id: p.querySelector<HTMLSelectElement>("[data-phase]")!.value || null,
        channel: p.querySelector<HTMLSelectElement>("[data-chan]")!.value,
        scale: Math.max(0.25, Math.min(3, Number(p.querySelector<HTMLInputElement>("[data-mscale]")!.value) / 100 || 1)),
        ...(modDefs ? { sidc: nextSidc() } : {}),
        ...(isMB
          ? {
              orbat_node_id: p.querySelector<HTMLSelectElement>("[data-onode]")!.value || null,
              orbat_strength: Math.max(1, Number(p.querySelector<HTMLInputElement>("[data-ostr]")!.value) || 1),
            }
          : {}),
      };
      const wantLock = p.querySelector<HTMLInputElement>("[data-lock]")!.checked;
      const beforeData: Record<string, unknown> = {};
      for (const k of Object.keys(data)) beforeData[k] = (m as unknown as Record<string, unknown>)[k];
      const beforeLock = m.locked;
      socket.send({ type: "marker.modify", id: m.id, data });
      socket.send({ type: "marker.lock", id: m.id, locked: wantLock });
      const mid = m.id;
      pushCmd({
        undo: () => {
          socket.send({ type: "marker.modify", id: mid, data: beforeData });
          socket.send({ type: "marker.lock", id: mid, locked: beforeLock });
        },
        redo: () => {
          socket.send({ type: "marker.modify", id: mid, data });
          socket.send({ type: "marker.lock", id: mid, locked: wantLock });
        },
      });
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
      const label = await promptDialog(t("fav.labelPrompt"), { value: m.unit_text || m.sidc.slice(0, 8) });
      if (!label) return;
      await api.addFavorite({
        label,
        sidc: m.sidc,
        rotation_degrees: m.rotation_degrees,
        unit_text: m.unit_text,
        ai_text: m.ai_text,
        channel: m.channel,
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
