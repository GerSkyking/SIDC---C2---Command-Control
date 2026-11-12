// Plan-Ansicht: Karte + Werkzeugleiste + HUD + Marker/Zeichnen/Präsenz live.
// Nähert sich der ATAKmaps-UI an (D:\Mods\ATAKmaps).
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import { api, type Me } from "./api";
import { loadAllMarkers, loadModifiers, loadPhaseLineStyle, loadTranslations, translate } from "./sidc/catalog";
import {
  isTextMarker,
  lngLatToWorld,
  markerLabelCategory,
  type Calibration,
} from "./sidc/sidc";
import { toast } from "./notify";
import { makeMovable } from "./movable";
import { ensureMapIcon, mapIconId, markerLabelOffsets } from "./sidc/symbol";
import { openAclEditor } from "./acl";
import { openHelp } from "./help";
import { openVersionPanel } from "./versions";
import { t } from "./i18n";
import { icon } from "./icons";
import { iconBtn, themeSwitch, wireThemeSwitch, wireTopbarMenu } from "./ui";
import { PlanSocket, type WsMessage } from "./ws";
import { esc } from "./esc";
import { initNavCube } from "./navcube";
import { wireScaleBox } from "./scalebox";
import { shotOptsMarkup, wireShotOpts, renderMapCanvas, mimeExt } from "./screenshot";
import type { ImagePlacement, PlanImage } from "./api";

import {
  createUi,
  IS_MOBILE,
  type ActAs,
  type Annot,
  type Cmd,
  type Marker,
  type Peer,
  type PhaseT,
  type PlanCtx,
  type Stroke,
  type TacLayer,
} from "./plan/ctx";
import { createModel, type PlanModel } from "./plan/model";
import { initImages } from "./plan/images";
import { initAreas } from "./plan/areas";
import { initAnnots } from "./plan/annots";
import { initStarDialog } from "./plan/starDialog";
import { initLayers } from "./plan/layers";
import { initTactical } from "./plan/tactical";
import { initOrbatPanel } from "./plan/orbatPanel";
import { initGrid } from "./plan/grid";
import { initTimeline } from "./plan/timeline";
import { initPhaseNotes } from "./plan/phaseNotes";
import { initFavorites } from "./plan/favorites";
import { initMarkers } from "./plan/markers";
import { initToolbar } from "./plan/toolbar";
import { initStrokes } from "./plan/strokes";
import { initEraser } from "./plan/eraser";
import { initContextMenu, initMapClicks } from "./plan/interaction";
import { emptyFC, imgToJpeg, lineDraftFC, packedToHex } from "./plan/geo";
export async function openPlanView(root: HTMLElement, planId: string, me: Me): Promise<void> {
  const snap = await api.snapshot(planId);
  const mapId: string = snap.plan.map_id;
  const cal: Calibration | null = snap.map_meta?.calibration ?? null;
  const markers = new Map<string, Marker>(snap.markers.map((m: Marker) => [m.id, m]));
  const strokes = new Map<string, Stroke>(snap.strokes.map((s: Stroke) => [s.id, s]));
  const annots = new Map<string, Annot>(
    (snap.annotations ?? []).map((a: Annot) => [a.id, a]),
  );
  const images = new Map<string, PlanImage>(
    (snap.images ?? []).map((i: PlanImage) => [i.id, i]),
  );
  // Ein Bild kann beliebig oft (auch in mehreren Phasen) auf der Karte platziert
  // sein — jede Platzierung ist ein eigener Eintrag mit eigener Position/Größe.
  const placements = new Map<string, ImagePlacement>(
    (snap.image_placements ?? []).map((p: ImagePlacement) => [p.id, p]),
  );
  // Alle document/window-Listener dieser Plan-Ansicht hängen an diesem Signal und
  // werden beim Verlassen (hashchange) gemeinsam abgeräumt.
  const life = new AbortController();
  const sig = life.signal;
  // Projekt-Verweise: gehört der Plan zu einem Projekt, werden {{…}}-Codes in Textfeldern/Phasen-Notizen
  // zu Chips (siehe model.wireRefs); sonst bleiben sie inaktiv.
  const projectId: string | null = snap.plan.project_id ?? null;
  // `/plans` listet nur Pläne ohne Projekt; Projekt-Pläne stehen in `/plans/in-projects`.
  const myPlan = projectId
    ? (await api.plansInProjects()).find((p) => p.id === planId)
    : (await api.plans()).find((p) => p.id === planId);
  const canEdit = myPlan?.level === "editor" || myPlan?.level === "owner";
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

  const lineColors = lineStyle?.colors ?? [
    { name: "Gelb", red: 255, green: 255, blue: 0, packedColor: -256, isDefault: true },
    { name: "Rot", red: 255, green: 0, blue: 0, packedColor: -65536, isDefault: false },
  ];
  const lineWidths = lineStyle?.widths ?? [{ width: 2, isDefault: true }, { width: 4, isDefault: false }];
  const peers = new Map<string, Peer>();
  const caps = { place: canEdit, move: canEdit, delete: canEdit, draw: canEdit };

  const isMB: boolean = !!me.is_mission_builder_effective;
  const phases: PhaseT[] = [...(snap.phases ?? [])].sort(
    (a: PhaseT, b: PhaseT) => a.ordering - b.ordering || (a.sub_ordering ?? 0) - (b.sub_ordering ?? 0),
  );
  const canZeus = isMB || !!me.is_zeus_effective;
  let outOpacity = Number(localStorage.getItem("sidc_phaseopacity") ?? "20"); // % fremde Phasen
  if (!Number.isFinite(outOpacity)) outOpacity = 20;
  let crossOpacity = Number(localStorage.getItem("sidc_crossopacity") ?? "20"); // % andere Ebene
  if (!Number.isFinite(crossOpacity)) crossOpacity = 20;
  let personalScale = Number(localStorage.getItem("sidc_marker_scale") ?? "1"); // nur für mich
  if (!Number.isFinite(personalScale) || personalScale <= 0) personalScale = 1;
  let textScale = Number(localStorage.getItem("sidc_text_scale") ?? "1"); // nur für mich
  if (!Number.isFinite(textScale) || textScale <= 0) textScale = 1;
  const phaseListeners: (() => void)[] = []; // z. B. Notiz-Fenster bei Phasenwechsel
  // ── Taktische Layer: Auto-Layer nach Identität + eigene Layer pro Plan ──
  const layerListeners: (() => void)[] = [];
  const tacKey = `sidc_tac_${planId}`;
  const tacState: Record<string, { on?: boolean; op?: number }> = (() => {
    try {
      return JSON.parse(localStorage.getItem(tacKey) || "{}") || {};
    } catch {
      return {};
    }
  })();
  const baseLayerVisible: Record<string, boolean> = {
    sat: true, satsimple: false, grid: true, contours: true, peaks: true, locations: true,
    buildings: false, roads: false, water: false, powerlines: false, trees: false,
  };

  const ctx: PlanCtx = {
    root,
    planId,
    me,
    snap,
    mapId,
    cal,
    markers,
    strokes,
    annots,
    images,
    placements,
    phases,
    projectId,
    myPlan,
    canEdit,
    isMB,
    canZeus,
    caps,
    lineColors,
    lineWidths,
    modCat,
    subCatBySidc,
    nameBySidc,
    langKeyBySidc,
    sig,
    map: null as unknown as maplibregl.Map, // wird direkt nach dem Seitenaufbau gesetzt
    socket: new PlanSocket(planId),
    peers,
    phaseListeners,
    layerListeners,
    tacKey,
    tacState,
    baseLayerVisible,
    strokesLayer: (() => {
      let done: () => void = () => {};
      const ready = new Promise<void>((r) => (done = r));
      return { ready, done: () => done() };
    })(),
    pendingStarZeus: new Map(),
    pendingStarArea: new Set(),
    model: null as unknown as PlanModel, // direkt darunter gesetzt
    ui: createUi(),
    tools: {},
    // veränderlicher Zustand
    mode: "move",
    pending: null,
    is3D: false,
    currentPhaseId: "",
    actAs: (() => {
      const v = localStorage.getItem(`sidc_actas_${planId}`);
      return v === "builder" && isMB ? "builder" : v === "zeus" && canZeus ? "zeus" : "player";
    })() as ActAs,
    lineColor: (lineColors.find((c) => c.isDefault) ?? lineColors[0]).packedColor,
    lineWidth: (lineWidths.find((w) => w.isDefault) ?? lineWidths[0]).width,
    outOpacity,
    crossOpacity,
    personalScale,
    textScale,
    // Einheits-/Zusatztext ein-/ausblenden — Control-Measure-Beschriftung (cm/line)
    // bleibt dabei immer stehen, nur der Text an normalen Einheiten wird versteckt.
    showUnitAiLabels: localStorage.getItem("sidc_labels_on") !== "0",
    // Großer Beschreibungsblock im Marker-Hover — standardmäßig aus.
    showMarkerInfo: localStorage.getItem("sidc_markerinfo") === "1",
    tacLayers: ((snap.layers ?? []) as TacLayer[]).filter((l) => !l.is_default),
    planOrbatCache: [],
    hoverLngLat: null,
    hoverMarkerId: null,
    measureLines: [],
    measureActive: [],
    measureCursor: null,
    measurePhaseId: null,
    editMeasureId: null,
    editStrokeId: null,
    linePts: [],
    lineCursor: null,
    linePhaseId: null,
    vertTouchDrag: false,
    chainGroup: null,
    chainIndex: 0,
    awaitingPos: false,
    pendingPos: null,
    dragId: null,
    annotResizingId: null,
    pendingAnnotCid: null,
    areaDraft: null,
    areaCursor: null,
    editAreaId: null,
    imgResizingId: null,
  };
  const model = (ctx.model = createModel(ctx));
  const {
    markerLabel,
    upsertPeer,
    isNotesPhase,
    playerPhases,
    unitAiOpacityExpr,
    tacOpacity,
    selectablePhases,
    multiPhaseOpacity,
    phaseOpacity,
    hk,
  } = model;
  ctx.currentPhaseId = playerPhases()[0]?.id ?? phases[0]?.id ?? "";

  root.innerHTML = `
    <div class="topbar">
      <a href="#/" title="${t("nav.back")}">${icon("back")}</a>
      <strong>${esc(snap.plan.name)}</strong>
      <span class="badge" title="${t("plan.yourRole")}">${esc(myPlan?.level ?? "?")}</span>
      <button id="t3d" title="${t("map.threeD")}">3D</button>
      ${iconBtn("north", { id: "compass", cls: "compass", title: t("map.compass") + hk("north") })}
      <label class="chk" title="${t("map.lockRotHint")}"><input type="checkbox" id="rotLock" /> ${t("map.lockRot")}</label>
      ${
        canEdit
          ? iconBtn("undo", { id: "undo", title: t("edit.undo") + hk("undo") }) +
            iconBtn("redo", { id: "redo", title: t("edit.redo") + hk("redo") })
          : ""
      }
      <input type="datetime-local" id="dtg" title="${t("map.dtg")}" />
      <span class="shot-wrap">${iconBtn("camera", { id: "shot", title: t("map.screenshot") })}${shotOptsMarkup()}</span>
      ${iconBtn("pdf", { id: "briefing", title: t("briefing.export") })}
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
      ${iconBtn("logout", { id: "logoutBtn", title: t("auth.logout") })}
      ${iconBtn("menu", { id: "tbMore", title: t("topbar.more") })}
    </div>
    <div id="map"></div>
    <div id="annots" class="annots"></div>
    <div id="plan-images" class="plan-images"></div>
    <div class="toolbar" id="toolbar">
      ${
        canEdit
          ? iconBtn("pan", { data: { mode: "move" }, active: true, title: t("tool.move") + hk("mapMove") }) +
            (IS_MOBILE ? iconBtn("markerMove", { data: { mode: "markermove" }, title: t("tool.markermove") + hk("markermove") }) : "") +
            iconBtn("point", { data: { mode: "point" }, title: t("tool.point") + hk("point") }) +
            iconBtn("line", { data: { mode: "line" }, title: t("tool.line") + hk("line") }) +
            iconBtn("ruler", { data: { mode: "measure" }, title: t("tool.measure") + hk("measure") }) +
            iconBtn("eraser", { data: { mode: "erase" }, title: t("tool.erase") + hk("erase") }) +
            iconBtn("textbox", { data: { mode: "text" }, title: t("tool.text") + hk("text") }) +
            iconBtn("marker", { id: "tool-marker", title: t("tool.marker") + hk("place") }) +
            // Verweise setzen braucht nur der Missionsbau, daher eigene Gruppe; ohne Projekt gesperrt
            (isMB
              ? `<span class="tb-sep"></span>` +
                iconBtn("spot", { id: "tool-ref", title: projectId ? t("tool.ref") : t("tool.refNoProject") })
              : "") +
            `<span class="tb-sep"></span>`
          : ""
      }
      ${iconBtn("layers", { id: "layersBtn", title: t("tool.layers") })}
      ${iconBtn("tactical", { id: "tacBtn", title: t("tool.tactical") })}
      ${iconBtn("groups", { id: "orbatBtn", title: t("orbat.inPlan") })}
      ${canEdit ? iconBtn("star", { id: "tool-fav", title: t("tool.fav") + hk("fav") }) : ""}
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
               .map((w) => `<option value="${w.width}" ${w.width === ctx.lineWidth ? "selected" : ""}>${w.width}</option>`)
               .join("")}</select>
             <label>${t("phase.assign")}</label>
             <select id="lPhase">
               ${selectablePhases()
                 .map((ph) => `<option value="${esc(ph.id)}">${ph.plane === "builder" ? "⚑ " : ""}${esc(ph.name)}</option>`)
                 .join("")}
             </select>
             <label>${t("phase.extra")}</label>
             <div id="lXph"></div>
             <label>${t("wiz.layer")}</label>
             <select id="lLayer"></select>
             <button class="primary" id="lineFinish">${t("line.finish")}</button>
             <p class="muted" style="margin:.35rem 0 0;font-size:.72rem">${t("line.rmbHint")}</p>
           </div>
           <div class="line-style" id="measureStyle" hidden>
             <div class="fav-head">${t("tool.measure").split(" – ")[0]}</div>
             <label>${t("phase.assign")}</label>
             <select id="mPhase">
               ${selectablePhases()
                 .map((ph) => `<option value="${esc(ph.id)}">${ph.plane === "builder" ? "⚑ " : ""}${esc(ph.name)}</option>`)
                 .join("")}
             </select>
             <label>${t("phase.extra")}</label>
             <div id="mXph"></div>
             <label>${t("wiz.layer")}</label>
             <select id="mLayer"></select>
           </div>`
        : ""
    }
    <div class="hud" id="hud">X: –  Y: –  H: –</div>
    <div class="mk-scale" id="mkScale">
      <button type="button" class="mk-scale-head" title="${t("scale.toggle")}"><span>${t("scale.title")}</span><span class="chev">▾</span></button>
      <div class="mk-scale-row" title="${t("marker.scaleLocal")}">
        ${icon("marker", 13)}
        <input type="range" id="mkScaleIn" min="25" max="300" step="5" value="${Math.round(ctx.personalScale * 100)}" />
        <span id="mkScaleV">${Math.round(ctx.personalScale * 100)}%</span>
      </div>
      <div class="mk-scale-row" title="${t("marker.textScaleLocal")}">
        ${icon("textbox", 13)}
        <input type="range" id="mkTextScaleIn" min="25" max="300" step="5" value="${Math.round(ctx.textScale * 100)}" />
        <span id="mkTextScaleV">${Math.round(ctx.textScale * 100)}%</span>
      </div>
    </div>
    <button class="line-done" id="lineDone" title="${t("line.finish")}" hidden>${icon("check", 18)}</button>
    <button class="line-done line-gear" id="strokeGear" title="${t("line.edit")}" hidden>${icon("settings", 16)}</button>
    <button class="line-done line-gear line-del" id="strokeDel" title="${t("line.delete")}" hidden>${icon("trash", 16)}</button>
    <div class="eraser-ring" id="eraserRing" hidden></div>
    <div class="eraser-panel" id="eraserPanel" hidden>
      <div class="fav-head">${t("tool.erase").split(" – ")[0]}</div>
      <label>${t("erase.size")}</label>
      <input type="range" id="eraserSize" min="8" max="150" step="1" />
      <div class="muted" id="eraserInfo" style="font-size:.75rem"></div>
    </div>
    <div class="navcube" id="navcube" hidden></div>
    <div class="layers-panel" id="layersPanel" hidden></div>
    <div class="layers-panel" id="tacPanel" hidden></div>
    <div class="layers-panel orbat-panel" id="orbatPanel" hidden></div>
    <canvas class="grid-canvas" id="gridCanvas"></canvas>`;

  const map = (ctx.map = new maplibregl.Map({
    container: "map",
    style: `/api/maps/${mapId}/style.json`,
    maxPitch: 0, // 2D: nur Drehen, kein Kippen — der 3D-Schalter hebt das an
    canvasContextAttributes: { preserveDrawingBuffer: true }, // für Screenshots (toDataURL)
    attributionControl: false, // kein MapLibre-Logo / Attribution-Box
    transformRequest: (url) =>
      url.startsWith("/") || url.startsWith(location.origin) ? { url, credentials: "include" } : { url },
  }));
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

  // Topbar bricht je nach Fensterbreite/Zeitleiste auf mehrere Zeilen um — die
  // Karte darunter richtet sich nach der tatsächlichen Topbar-Höhe (CSS-Variable).
  const topbarEl = root.querySelector<HTMLElement>(".topbar")!;
  const syncTopbarH = () => {
    if (topbarEl.classList.contains("tb-open")) return; // aufgeklapptes Mobil-Menü überdeckt die Karte nur
    root.style.setProperty("--topbar-h", `${Math.ceil(topbarEl.getBoundingClientRect().height)}px`); // inkl. Zoom (Topbar-Größe)
    map.resize();
  };
  syncTopbarH();
  wireTopbarMenu(topbarEl);
  const topbarRO = new ResizeObserver(syncTopbarH);
  topbarRO.observe(topbarEl);
  window.addEventListener("resize", syncTopbarH);
  window.addEventListener(
    "hashchange",
    () => {
      topbarRO.disconnect();
      window.removeEventListener("resize", syncTopbarH);
      root.style.removeProperty("--topbar-h");
      life.abort();
      try {
        map.remove(); // WebGL-Kontext freigeben
      } catch {
        /* schon entfernt */
      }
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
  // Deep-Link aus dem Projekt-Verzeichnis („Auf der Karte“): #/plans/<id>?annot=<id> fliegt zur Annotation
  map.once("load", () => {
    const aid = location.hash.match(/[?&]annot=([0-9a-f]{32})/)?.[1];
    const a = aid ? annots.get(aid) : undefined;
    if (a) map.flyTo({ center: [a.world_x, a.world_y], essential: true });
  });
  map.on("style.load", applyCameraBounds);

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
  const strokeFC = (): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: [...strokes.values()].map((s) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: s.points },
      properties: {
        id: s.id,
        color: packedToHex(s.color),
        width: s.width > 0 ? s.width : 2,
        opacity: multiPhaseOpacity(s.phase_id, s.extra_phase_ids) * tacOpacity(null, s.layer_id),
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
  const refreshStrokes = () => (map.getSource("strokes") as GeoJSONSource)?.setData(strokeFC());
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

  // ── WebSocket ──────────────────────────────────────────────────────────
  const socket = ctx.socket;
  let lastDropToast = 0;
  socket.onDropped = () => {
    // Nicht still verlieren: Nutzer sieht, dass die Änderung NICHT angekommen ist.
    if (Date.now() - lastDropToast < 3000) return;
    lastDropToast = Date.now();
    toast(t("ws.dropped"), { kind: "error" });
  };

  // ── Undo/Redo (eigene Aktionen: verschieben, bearbeiten, sperren) ─────
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
  ctx.ui.pushCmd = pushCmd;
  const doUndo = (): void => {
    const c = undoStack.pop();
    if (!c) return;
    c.undo();
    redoStack.push(c);
    updateUndoBtns();
  };
  ctx.ui.doUndo = doUndo;
  const doRedo = (): void => {
    const c = redoStack.pop();
    if (!c) return;
    c.redo();
    undoStack.push(c);
    updateUndoBtns();
  };

  ctx.ui.doRedo = doRedo;

  const presenceEl = root.querySelector<HTMLSpanElement>("#presence")!;
  const names = new Map<string, string>();
  const renderPresence = () =>
    (presenceEl.innerHTML = [...names.values()].map((n) => `<span class="badge">${esc(n)}</span>`).join(""));

  socket.on((msg: WsMessage) => {
    switch (msg.type) {
      case "hello":
        Object.assign(caps, msg.caps);
        ctx.ui.applyCaps();
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
          upsertPeer(msg.uid, names.get(msg.uid) ?? "?", msg.lng, msg.lat, !!msg.hl, (msg.arrow as [number, number] | null) ?? null);
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
        if (ctx.editStrokeId === msg.stroke.id) refreshStrokeVerts();
        break;
      case "stroke.delete":
        strokes.delete(msg.id);
        refreshStrokes();
        if (ctx.editStrokeId === msg.id) setEditStroke(null);
        break;
      case "annotation.upsert": {
        const wasResizing = ctx.annotResizingId === msg.annotation.id;
        annots.set(msg.annotation.id, msg.annotation);
        if (!ctx.annotResizingId) ctx.ui.renderAnnots(); // während eines Resize nicht neu aufbauen
        else if (!wasResizing) ctx.ui.positionAnnots();
        if (msg.cid && msg.cid === ctx.pendingAnnotCid) {
          ctx.pendingAnnotCid = null;
          ctx.ui.openAnnotEditor(msg.annotation.id, true);
        }
        if (msg.cid && ctx.pendingStarArea.has(msg.cid)) {
          ctx.pendingStarArea.delete(msg.cid);
          ctx.ui.startAreaDraw(msg.annotation.id);
        }
        if (msg.cid && ctx.pendingStarZeus.has(msg.cid)) {
          const z = ctx.pendingStarZeus.get(msg.cid)!;
          ctx.pendingStarZeus.delete(msg.cid);
          socket.send({ type: "annotation.modify", id: msg.annotation.id, data: z });
        }
        break;
      }
      case "annotation.delete":
        annots.delete(msg.id);
        ctx.ui.renderAnnots();
        break;
      case "image.upsert":
        images.set(msg.image.id, msg.image);
        if (!ctx.imgResizingId) ctx.ui.renderMapImages(); // Beschriftung/Notiz können in Hover/Popover sichtbar sein
        ctx.ui.refreshImageRail();
        break;
      case "image.delete":
        images.delete(msg.id);
        // Alle Platzierungen dieses Bilds lokal mit entfernen (Server-CASCADE
        // sendet dafür keine einzelnen placement.delete-Nachrichten).
        for (const p of [...placements.values()]) if (p.image_id === msg.id) placements.delete(p.id);
        ctx.ui.renderMapImages();
        ctx.ui.refreshImageRail();
        break;
      case "placement.upsert":
        placements.set(msg.placement.id, msg.placement);
        if (!ctx.imgResizingId) ctx.ui.renderMapImages();
        else ctx.ui.positionImages();
        ctx.ui.refreshImageRail();
        break;
      case "placement.delete":
        placements.delete(msg.id);
        ctx.ui.renderMapImages();
        ctx.ui.refreshImageRail();
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
  const DEM_MAX = 48; // ~48 Kacheln (je ~256 KB) im Speicher, älteste fliegen raus
  const demSet = (key: string, v: ImageData | null): void => {
    demImg.delete(key);
    demImg.set(key, v);
    if (demImg.size > DEM_MAX) demImg.delete(demImg.keys().next().value as string);
  };
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
            demSet(key, cx.getImageData(0, 0, c.width, c.height));
          } catch {
            demSet(key, null);
          }
          demBusy.delete(key);
        };
        im.onerror = () => {
          demSet(key, null);
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

  ctx.ui.sampleElevation = sampleElevation;

  // ── HUD (Cursor X/Y/Höhe) ──────────────────────────────────────────────
  const hud = root.querySelector<HTMLDivElement>("#hud")!;
  makeMovable(hud, { plan: planId, key: "hud" });
  makeMovable(root.querySelector<HTMLDivElement>("#mkScale")!, { plan: planId, key: "mkscale" });
  let lastCursorSent = 0;
  map.on("mousemove", (e) => {
    ctx.hoverLngLat = { lng: e.lngLat.lng, lat: e.lngLat.lat };
    const [wx, wy] = lngLatToWorld(cal, e.lngLat.lng, e.lngLat.lat);
    let h = "–";
    try {
      const el = ctx.is3D
        ? (map.queryTerrainElevation(e.lngLat) ?? 0) / 1.5
        : sampleElevation(e.lngLat.lng, e.lngLat.lat);
      if (el != null) h = `${Math.round(el)} m`;
    } catch {
      /* keine Höhendaten */
    }
    hud.textContent = `X: ${wx.toFixed(0)}  Y: ${wy.toFixed(0)}  H: ${h}`;
    trackCursor(e.lngLat.lng, e.lngLat.lat);
  });
  // Vorschau-Linie / Messlinie / Zeiger folgen dem Zeiger bzw. dem Finger
  const trackCursor = (lng: number, lat: number) => {
    if (ctx.mode === "measure" && ctx.measureActive.length) {
      ctx.measureCursor = [lng, lat];
      ctx.ui.redrawMeasure();
    }
    if (ctx.mode === "point") sendPointer(lng, lat);
    if (ctx.mode === "line" && ctx.linePts.length) {
      ctx.lineCursor = [lng, lat];
      (map.getSource("linedraft") as GeoJSONSource)?.setData(lineDraftFC(ctx.linePts, ctx.lineCursor));
    }
  };
  map.on("touchmove", (e) => {
    if (e.points.length === 1) trackCursor(e.lngLat.lng, e.lngLat.lat);
  });
  // Zeigen: Linksklick = gelbe Hervorhebung, Rechtsklick halten + ziehen = Pfeil (nur solange gehalten)
  let ptrHl = false;
  let ptrArrowFrom: [number, number] | null = null;
  let ptrLast: [number, number] | null = null;
  const sendPointer = (lng: number, lat: number, force = false) => {
    if (!force && Date.now() - lastCursorSent <= 60) return;
    lastCursorSent = Date.now();
    ptrLast = [lng, lat];
    socket.send({ type: "presence.cursor", lng, lat, hl: ptrHl, arrow: ptrArrowFrom });
    // eigener Zeiger auch bei mir anzeigen
    upsertPeer(me.id, me.display_name || me.username, lng, lat, ptrHl, ptrArrowFrom);
    refreshPeers();
  };
  map.on("mousedown", (e) => {
    if (ctx.mode !== "point") return;
    if (e.originalEvent.button === 0) ptrHl = true;
    else if (e.originalEvent.button === 2) ptrArrowFrom = [e.lngLat.lng, e.lngLat.lat];
    else return;
    sendPointer(e.lngLat.lng, e.lngLat.lat, true);
  });
  const releasePtr = () => {
    if (!ptrHl && !ptrArrowFrom) return;
    ptrHl = false;
    ptrArrowFrom = null;
    if (ctx.mode === "point" && ptrLast) sendPointer(ptrLast[0], ptrLast[1], true);
  };
  document.addEventListener("mouseup", releasePtr, { signal: sig });
  // Werkzeugwechsel weg von „Zeigen“: Hervorhebung/Pfeil beenden, eigenen Zeiger entfernen
  ctx.ui.resetPointer = () => {
    ptrHl = false;
    if (ptrArrowFrom) {
      ptrArrowFrom = null;
      if (ptrLast) sendPointer(ptrLast[0], ptrLast[1], true); // Pfeil bei den anderen beenden
    }
    if (peers.has(me.id)) {
      peers.delete(me.id);
      refreshPeers();
    }
  };
  // Touch: Zeigen folgt dem Finger (ein Finger); ein zweiter Finger beendet es und navigiert die Karte
  map.on("touchstart", (e) => {
    if (ctx.mode !== "point") return;
    if (e.points.length !== 1) return releasePtr();
    ptrHl = true;
    sendPointer(e.lngLat.lng, e.lngLat.lat, true);
  });
  document.addEventListener("touchend", () => releasePtr(), { signal: sig });
  document.addEventListener("touchcancel", () => releasePtr(), { signal: sig });

  // ── 2D/3D + Navigations-Würfel ───────────────────────────────────────
  const navcube = root.querySelector<HTMLDivElement>("#navcube")!;
  wireScaleBox(root);
  initNavCube(map, navcube); // immer sichtbar (2D + 3D)
  navcube.hidden = false;

  root.querySelector("#t3d")!.addEventListener("click", () => {
    ctx.is3D = !ctx.is3D;
    root.querySelector("#t3d")!.classList.toggle("active", ctx.is3D);
    const hasDem = !!map.getSource("terrain-dem");
    if (ctx.is3D) {
      if (hasDem) map.setTerrain({ source: "terrain-dem", exaggeration: 1.5 });
      map.setMaxPitch(85);
      map.easeTo({ pitch: 60, duration: 700 });
    } else {
      // 2D: Terrain-Mesh abschalten → deutlich ressourcenschonender.
      map.easeTo({ pitch: 0, duration: 700 });
      map.once("moveend", () => {
        if (!ctx.is3D) {
          if (hasDem) map.setTerrain(null);
          map.setMaxPitch(0); // Kippen wieder sperren, Drehung bleibt
        }
      });
    }
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
  const DTG_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const p2 = (n: number) => String(n).padStart(2, "0");
  const shotDate = () => (dtgInput.value ? new Date(dtgInput.value) : new Date());
  // Militärisches Format "DDHHMMZ MMM YY" (eingegebene Zeit als Zulu gelesen).
  const militaryDtg = (d: Date) =>
    `${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}Z ${DTG_MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}`;

  // ── Screenshot: nur Karteninhalt (Sat/Grid + Orte + Marker + Zeichnungen
  //    + Richtungspfeile), keine Bedienelemente. Unten links der DTG.
  const gridCanvas = root.querySelector<HTMLCanvasElement>("#gridCanvas")!;
  const shotBtn = root.querySelector<HTMLButtonElement>("#shot")!;
  const getShotOpts = wireShotOpts(root);
  shotBtn.addEventListener("click", async () => {
    shotBtn.disabled = true;
    try {
      const opts = getShotOpts();
      const out = await renderMapCanvas(map, opts);
      const g2d = out.getContext("2d")!;
      if (baseLayerVisible.grid !== false) g2d.drawImage(gridCanvas, 0, 0, out.width, out.height);

      const d = shotDate();
      const s = out.height / 1080; // Label-Skalierung, auflösungsunabhängig
      g2d.font = `bold ${Math.round(15 * s)}px monospace`;
      g2d.textBaseline = "bottom";
      g2d.lineWidth = 3 * s;
      g2d.strokeStyle = "rgba(0,0,0,0.85)";
      g2d.fillStyle = "#fff";
      const label = militaryDtg(d);
      const x = 12 * s;
      const y = out.height - 12 * s;
      g2d.strokeText(label, x, y);
      g2d.fillText(label, x, y);

      const phaseName = phases.find((p) => p.id === ctx.currentPhaseId)?.name ?? "global";
      const safe = (str: string) => str.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "map";
      const fileStamp =
        `${p2(d.getDate())}${p2(d.getMonth() + 1)}${d.getFullYear()}-` +
        `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
      const { mime, ext, quality } = mimeExt(opts.fmt);
      const a = document.createElement("a");
      a.href = out.toDataURL(mime, quality);
      a.download = `${safe(snap.plan.name)}_${safe(phaseName)}_${fileStamp}.${ext}`;
      a.click();
    } finally {
      shotBtn.disabled = false;
    }
  });

  // ── Briefing-PDF: je Phase eine Seite (Karte auf Phasen-Marker gerahmt) ──
  const briefingPlaneChoice = (): Promise<"player" | "builder" | null> =>
    new Promise((resolve) => {
      const back = document.createElement("div");
      back.className = "edit-modal";
      back.innerHTML = `<div class="card stack" style="width:min(22rem,94vw)">
        <h1 style="margin:0;font-size:1.05rem">${t("briefing.planeTitle")}</h1>
        <div class="row" style="gap:.5rem">
          <button class="primary" data-pl="player" style="flex:1">${t("mb.player")}</button>
          <button data-pl="builder" style="flex:1">${t("mb.builder")}</button>
        </div>
        <button data-pl="" class="muted">${t("common.cancel")}</button>
      </div>`;
      const done = (v: "player" | "builder" | null) => {
        back.remove();
        resolve(v);
      };
      back.addEventListener("mousedown", (e) => e.target === back && done(null));
      back.querySelectorAll<HTMLButtonElement>("[data-pl]").forEach((b) =>
        b.addEventListener("click", () => done((b.dataset.pl as "player" | "builder") || null)),
      );
      document.body.appendChild(back);
    });
  const briefingBtn = root.querySelector<HTMLButtonElement>("#briefing")!;
  briefingBtn.addEventListener("click", async () => {
    briefingBtn.disabled = true;
    const origPhase = ctx.currentPhaseId;
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
    // Missionsbauer wählt, für welche Ebene das Briefing gilt.
    let plane: "player" | "builder" = "player";
    if (isMB) {
      const choice = await briefingPlaneChoice();
      if (choice === null) {
        briefingBtn.disabled = false;
        return;
      }
      plane = choice;
    }
    const briefPhases = phases.filter((p) => (p.plane ?? "player") === plane && !isNotesPhase(p));

    try {
      const { jsPDF } = await import("jspdf");
      const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      const pw = doc.internal.pageSize.getWidth();
      const ph = doc.internal.pageSize.getHeight();
      const d = shotDate();

      for (let pi = 0; pi < briefPhases.length; pi++) {
        const phase = briefPhases[pi];
        if (pi > 0) doc.addPage();
        ctx.currentPhaseId = phase.id;
        // Marker dieser Phase (+ globale) für den Bildausschnitt
        const pts = [...markers.values()]
          .filter((m) => m.phase_id === phase.id || m.phase_id == null || (m.extra_phase_ids ?? []).includes(phase.id))
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
        doc.text(`${snap.plan.name} — ${phase.name}  (${pi + 1}/${briefPhases.length})`, 12, 14);
        doc.setFontSize(9);
        doc.text(militaryDtg(d), pw - 12, 14, { align: "right" });
        const imgW = pw * 0.62 - 12;
        const imgH = (imgW * cvs.height) / cvs.width;
        doc.addImage(img, "JPEG", 12, 20, imgW, Math.min(imgH, ph - 28));
        const nx = 12 + imgW + 8;
        const colW = pw - nx - 10;
        const notes = stripMd((phase.notes || "").replace(/\{\{img:[0-9a-f]{32}\}\}/g, "").trim());
        let ny = 26;
        if (notes) {
          doc.setFontSize(10);
          const lines = doc.splitTextToSize(notes, colW) as string[];
          doc.text(lines, nx, ny);
          ny += lines.length * 4.6 + 4;
        }
        // Bild-Verweise der Phase als echte Bilder unter den Notiztext
        const refs = [...(phase.notes || "").matchAll(/\{\{img:([0-9a-f]{32})\}\}/g)].map((m) => m[1]);
        for (const rid of refs) {
          const meta = images.get(rid);
          if (!meta) continue;
          try {
            const dataUrl = await imgToJpeg(api.planImageUrl(planId, rid));
            const ratio = meta.natural_w > 0 ? meta.natural_h / meta.natural_w : 0.6;
            let iw = colW;
            let ih = iw * ratio;
            if (ny + ih > ph - 12) {
              doc.addPage();
              ny = 20;
              if (ih > ph - 30) {
                ih = ph - 30;
                iw = ih / ratio;
              }
            }
            doc.addImage(dataUrl, "JPEG", nx, ny, iw, ih);
            ny += ih + 2;
            if (meta.caption) {
              doc.setFontSize(8);
              doc.text(doc.splitTextToSize(meta.caption, colW) as string[], nx, ny + 3);
              ny += 6;
            }
          } catch {
            /* Bild nicht ladbar -> überspringen */
          }
        }
      }
      // ── Kräfteübersicht: ORBAT-Knoten, die auf der Karte stehen ──
      await ctx.ui.ensureOrbatCache();
      const nodesOnMap = new Set(
        [...markers.values()].map((m) => m.orbat_node_id).filter(Boolean) as string[],
      );
      const forceItems = ctx.planOrbatCache.flatMap((o) =>
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
      ctx.currentPhaseId = origPhase;
      map.jumpTo({ center: origCenter, zoom: origZoom, bearing: origBearing });
      await refreshMarkers();
      ctx.ui.renderTimeline();
      briefingBtn.disabled = false;
    }
  });

  root.querySelector("#acl")?.addEventListener("click", () => openAclEditor(planId, snap.plan.name, undefined, isMB));
  root.querySelector("#help")!.addEventListener("click", openHelp);
  root.querySelector("#logoutBtn")!.addEventListener("click", async () => {
    await api.logout().catch(() => {});
    location.hash = "#/";
    location.reload();
  });
  root.querySelector("#present")!.addEventListener("click", () => ctx.ui.startPresent());
  root.querySelector("#undo")?.addEventListener("click", doUndo);
  root.querySelector("#redo")?.addEventListener("click", doRedo);
  updateUndoBtns();
  if (canEdit) {
    const onUndoKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const tg = e.target as HTMLElement | null;
      // In Eingabefeldern gehört Ctrl+Z/Y dem Browser (Text-Undo)
      if (tg && (tg.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName))) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        doUndo();
      } else if (k === "y" || (k === "z" && e.shiftKey)) {
        e.preventDefault();
        doRedo();
      }
    };
    document.addEventListener("keydown", onUndoKey, { signal: sig });
  }

  // Plan-Vorschaubild (Thumbnail) — bei Versions-Speichern + einmal kurz nach dem Laden.
  async function captureThumb(): Promise<void> {
    if (!canEdit || sig.aborted) return;
    try {
      await new Promise<void>((res, rej) => {
        if (map.loaded() && !map.isMoving()) return res();
        const to = window.setTimeout(() => rej(new Error("idle-timeout")), 8000);
        map.once("idle", () => {
          window.clearTimeout(to);
          res();
        });
      });
      if (sig.aborted) return;
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

  initTimeline(ctx);
  initPhaseNotes(ctx);
  {
    const si = root.querySelector<HTMLInputElement>("#mkScaleIn")!;
    const sv = root.querySelector<HTMLSpanElement>("#mkScaleV")!;
    si.addEventListener("input", () => {
      ctx.personalScale = Number(si.value) / 100 || 1;
      sv.textContent = `${si.value}%`;
      try {
        localStorage.setItem("sidc_marker_scale", String(ctx.personalScale));
      } catch {
        /* ignore */
      }
      void refreshMarkers();
    });
  }
  {
    const si = root.querySelector<HTMLInputElement>("#mkTextScaleIn")!;
    const sv = root.querySelector<HTMLSpanElement>("#mkTextScaleV")!;
    si.addEventListener("input", () => {
      ctx.textScale = Number(si.value) / 100 || 1;
      sv.textContent = `${si.value}%`;
      try {
        localStorage.setItem("sidc_text_scale", String(ctx.textScale));
      } catch {
        /* ignore */
      }
      map.setLayoutProperty("marker-unittext", "text-size", 11 * ctx.textScale);
      map.setLayoutProperty("marker-aitext", "text-size", 11 * ctx.textScale);
      map.setLayoutProperty("marker-textmark", "text-size", 14 * ctx.textScale);
      void refreshMarkers(); // Text-Offsets neu berechnen, sonst rückt der Text vom Icon weg
    });
  }

  await initLayers(ctx);
  initTactical(ctx);
  initOrbatPanel(ctx);
  initGrid(ctx);

  if (!canEdit) return;

  initToolbar(ctx);
  initStrokes(ctx);
  initEraser(ctx);
  await initFavorites(ctx);
  initMarkers(ctx);
  initContextMenu(ctx);
  initAreas(ctx);
  initAnnots(ctx);
  initImages(ctx);
  initStarDialog(ctx);
  initMapClicks(ctx);
}
