// Plan-Ansicht: Karte + Werkzeugleiste + HUD + Marker/Zeichnen/Präsenz live.
// Nähert sich der ATAKmaps-UI an (D:\Mods\ATAKmaps).
//
// Dieses Gerüst lädt den Plan, baut den gemeinsamen Kontext (plan/ctx.ts) und die Seite auf und startet
// die Feature-Module unter plan/ in fester Reihenfolge (die Reihenfolge bestimmt, in welcher Reihenfolge
// Karten-/Dokument-Listener registriert werden — siehe Kommentare bei den init-Aufrufen).
import * as maplibregl from "maplibre-gl";
import { api, type ImagePlacement, type Me, type PlanImage } from "./api";
import { loadAllMarkers, loadModifiers, loadPhaseLineStyle, loadTranslations, translate } from "./sidc/catalog";
import type { Calibration } from "./sidc/sidc";
import { openAclEditor } from "./acl";
import { openHelp } from "./help";
import { t } from "./i18n";
import { icon } from "./icons";
import { iconBtn, themeSwitch, wireTopbarMenu } from "./ui";
import { PlanSocket } from "./ws";
import { esc } from "./esc";
import { shotOptsMarkup } from "./screenshot";
import {
  createUi,
  IS_MOBILE,
  type ActAs,
  type Annot,
  type Marker,
  type Peer,
  type PhaseT,
  type PlanCtx,
  type Stroke,
  type TacLayer,
} from "./plan/ctx";
import { createModel, type PlanModel } from "./plan/model";
import { initRender } from "./plan/render";
import { initLive } from "./plan/live";
import { initUndo } from "./plan/undo";
import { initHud } from "./plan/hud";
import { initExport } from "./plan/export";
import { initTimeline } from "./plan/timeline";
import { initPhaseNotes } from "./plan/phaseNotes";
import { initLayers } from "./plan/layers";
import { initTactical } from "./plan/tactical";
import { initOrbatPanel } from "./plan/orbatPanel";
import { initGrid } from "./plan/grid";
import { initToolbar } from "./plan/toolbar";
import { initStrokes } from "./plan/strokes";
import { initEraser } from "./plan/eraser";
import { initFavorites } from "./plan/favorites";
import { initMarkers } from "./plan/markers";
import { initContextMenu, initMapClicks } from "./plan/interaction";
import { initAreas } from "./plan/areas";
import { initAnnots } from "./plan/annots";
import { initImages } from "./plan/images";
import { initStarDialog } from "./plan/starDialog";
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
  ctx.model = createModel(ctx);
  const { playerPhases, selectablePhases, hk } = ctx.model;
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
          <p class="muted" style="margin:.2rem 0 0;font-size:.72rem">${t("line.closeHint")}</p>
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

  initRender(ctx);

  initLive(ctx);
  initUndo(ctx);


  initHud(ctx);

  initExport(ctx);

  root.querySelector("#acl")?.addEventListener("click", () => openAclEditor(planId, snap.plan.name, undefined, isMB));
  root.querySelector("#help")!.addEventListener("click", openHelp);
  root.querySelector("#logoutBtn")!.addEventListener("click", async () => {
    await api.logout().catch(() => {});
    location.hash = "#/";
    location.reload();
  });
  root.querySelector("#present")!.addEventListener("click", () => ctx.ui.startPresent());


  initTimeline(ctx);
  initPhaseNotes(ctx);

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
