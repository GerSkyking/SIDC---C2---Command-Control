// Gemeinsamer Zustand der Plan-Ansicht (plan.ts + Module in plan/).
//
// Regeln:
//  - Feste Werte (map, socket, Daten-Maps, phases-Array, model …) ändern ihre Identität nie und
//    dürfen in einem Modul per Destrukturierung übernommen werden.
//  - Veränderlicher Zustand (mode, currentPhaseId, actAs …) wird IMMER über `ctx.<feld>` gelesen
//    und geschrieben — nie in eine lokale Variable kopieren, sonst hält das Modul eine veraltete Kopie.
//  - Funktionen, die ein Modul anderen bereitstellt, hängen an `ctx.ui` und werden IMMER als
//    `ctx.ui.<name>()` aufgerufen (Standard: No-op, bis das Modul initialisiert ist).
//  - Werkzeuge melden ihren Karten-Klick in `ctx.tools[mode]` an (siehe interaction.ts).
import type * as maplibregl from "maplibre-gl";
import type { ImagePlacement, Me, Orbat, PlanImage, PlanItem } from "../api";
import type { ModifierCatalog, PhaseLineStyle } from "../sidc/catalog";
import type { Calibration } from "../sidc/sidc";
import type { MarkerTemplate } from "../sidc/wizard";
import type { PlanSocket } from "../ws";
import type { PlanModel } from "./model";

export interface Marker {
  id: string;
  world_x: number;
  world_y: number;
  sidc: string;
  unit_text: string;
  ai_text: string;
  channel?: string;
  author?: string;
  locked: boolean;
  rotation_degrees: number;
  icon_rotation: number;
  scale?: number;
  tint?: string;
  phase_id: string | null;
  extra_phase_ids?: string[];
  layer_id: string | null;
  orbat_node_id?: string | null;
  orbat_strength?: number;
  released?: boolean;
  linked_group_id: number;
  point_index: number;
  line_color: number;
  line_width: number;
}
export interface Stroke {
  id: string;
  points: [number, number][];
  color: number;
  width: number;
  phase_id?: string | null;
  extra_phase_ids?: string[];
  layer_id?: string | null;
  channel?: string;
  /** Benannte Fläche: geschlossene Linie (Punkte offen gespeichert, ohne wiederholten Startpunkt). */
  closed?: boolean;
  name?: string;
  sidc?: string;
  /** Schraffur-Füllung (Standard an) */
  fill?: boolean;
  /** Art: "phaseline" (Linie/Fläche) oder "dot" (einfacher Punkt: 1 Punkt, width = Größe, name = Text) */
  kind?: string;
  /** Zusatztext zum Flächen-Symbol */
  ai_text?: string;
}
export type Mode = "move" | "markermove" | "point" | "line" | "dot" | "erase" | "place" | "measure" | "text" | "ref" | "area";
/** Standardfrist für Zeus-Freigaben (Phasen und Missionsbau-Notizen), in Stunden. */
export const ZEUS_DEFAULT_H = 72;
/** Stern-Pin auf der Karte (Farbe per CSS: gelb = für alle, pink = nur Missionsbau). */
export const STAR_SVG =
  '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d="M12 2.2l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"/></svg>';

// Touch-Gerät erkannt → "Marker verschieben" als Werkzeug anzeigen (am Desktop genügt die mittlere Maustaste).
export const IS_MOBILE =
  /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent) ||
  (matchMedia("(pointer: coarse)").matches && navigator.maxTouchPoints > 0);

export interface Annot {
  id: string;
  phase_id: string | null;
  extra_phase_ids?: string[];
  world_x: number;
  world_y: number;
  text: string;
  width: number;
  height?: number;
  scale_fixed?: boolean;
  ref_zoom?: number;
  zeus_released?: boolean; // Einzelfreigabe für Zeus (Karten-Notizen)
  zeus_until?: string | null;
  area?: AnnotArea | null; // Bereich um den Pin
  color?: string; // eigene Stern-Farbe "#rrggbb" (leer = Standard)
}
/** Bereich um einen Pin: offene Linie oder (closed) schraffierte Fläche, Punkte als [lng, lat]. */
export interface AnnotArea {
  pts: [number, number][];
  closed: boolean;
}
/** Farben der Bereiche: wie die Sterne (gelb = alle, pink = nur Missionsbau). */
export const AREA_COL = { mb: "#ff2d95", all: "#ffc21a" };
export const AREA_CLOSE_PX = 12; // so nah am Startpunkt = Fläche schließen
export const AREA_MAX_POINTS = 200; // wie im Backend

// Phasen / Zeitstrahl (+ Missionsbau-Parallelebene)
export interface PhaseT {
  id: string;
  name: string;
  ordering: number;
  notes: string;
  plane?: "player" | "builder";
  parent_id?: string | null;
  sub_ordering?: number;
  start_at?: string | null;
  end_at?: string | null;
  locked?: boolean;
  zeus_released?: boolean;
  zeus_until?: string | null;
  player_released?: boolean;
  role?: string | null; // "notes" = feste Ebene „Karten-Notizen“ (Projekt-Pläne)
}
export type ActAs = "player" | "builder" | "zeus";

// ── Taktische Layer: Auto-Layer nach Identität + eigene Layer pro Plan ──
export interface TacLayer {
  id: string;
  name: string;
  color: number;
  ordering: number;
  is_default?: boolean;
}
export type TacAuto = "bluefor" | "redfor" | "civgreen" | "unknown";
export const TAC_AUTO: TacAuto[] = ["bluefor", "redfor", "civgreen", "unknown"];

// hl: Zeitstempel bis zu dem der Punkt gelb hervorgehoben ist (Infinity = Linksklick gehalten);
// arrow: Startpunkt des Pfeils, solange diese Person rechts klickt+zieht.
export type Peer = { name: string; lng: number; lat: number; t: number; color: string; hl: number; arrow: [number, number] | null };

/** Lineal: mehrsegmentige, bleibende Messlinie (nur lokal, je Sitzung). */
export interface MeasureLine {
  id: string;
  pts: [number, number][];
  phase_id: string | null;
  extra_phase_ids: string[];
  layer_id: string | null;
}

export interface Cmd {
  undo: () => void;
  redo: () => void;
}
export type Span = { s: number; e: number };
export type LngLat2 = [number, number];

/** Kartenort aus locations.json (siehe layers.ts). */
export interface PlaceInfo {
  name: string;
  names: string[];
  lng: number;
  lat: number;
}

/** Karten-Klick eines Werkzeugs (nach der gemeinsamen Linien-Auswahl, siehe interaction.ts). */
export interface ToolHandlers {
  click?: (e: maplibregl.MapMouseEvent) => void;
}

/** Funktionen, die Module einander bereitstellen (spät gebunden, Standard = No-op). */
export interface PlanUi {
  // render.ts
  refreshMarkers: () => Promise<void>;
  refreshStrokes: () => void;
  refreshDir: () => void;
  redrawMarkersOnly: () => void;
  refreshChains: () => void;
  refreshStrokeVerts: () => void;
  setEditStroke: (id: string | null) => void;
  setEditMeasure: (id: string | null) => void;
  editPts: () => LngLat2[] | undefined;
  refreshPeers: () => void;
  // live.ts
  resync: () => Promise<void>;
  // undo.ts
  pushCmd: (c: Cmd) => void;
  doUndo: () => void;
  doRedo: () => void;
  // hud.ts
  resetPointer: () => void;
  sampleElevation: (lng: number, lat: number) => number | null;
  // timeline.ts
  renderTimeline: () => void;
  applyPhase: () => void;
  selectPhase: (id: string) => void;
  selectPlayerPhase: (pid: string) => void;
  stepPhase: (dir: number) => void;
  startPresent: () => void;
  addPlayerPhase: () => Promise<void>;
  addSubPhase: (parentId: string) => Promise<void>;
  patchPhaseTimes: (id: string, s: number | null, e: number | null) => void;
  computeSpans: () => Map<string, Span>;
  // phaseNotes.ts
  toggleNotesWin: () => void;
  repaintNotesTimes: () => void;
  // layers.ts
  flyToPlace: (mid: string, name: string) => boolean;
  /** Kartenorte (für die Suche): Anzeigename, alle Sprachvarianten, Position. */
  listPlaces: () => PlaceInfo[];
  belowTopbar: () => number;
  placeNextToTool: (panel: HTMLElement, btn: HTMLElement) => void;
  // tactical.ts
  /** Taktischen Layer (auto:<x>, Layer-ID oder "mbnotes") sichtbar schalten. */
  showTacLayer: (key: string) => void;
  // orbatPanel.ts
  ensureOrbatCache: () => Promise<void>;
  // grid.ts
  updateGrid: () => void;
  // toolbar.ts
  setMode: (m: Mode) => void;
  modeCursor: (m?: Mode) => string;
  syncDragPan: () => void;
  applyCaps: () => void;
  // strokes.ts
  positionLineDone: () => void;
  redrawMeasure: () => void;
  commitMeasure: () => void;
  finishLine: () => void;
  cancelLine: () => void;
  refreshLineDraft: () => void;
  renderMeasureX: () => void;
  renderLineX: () => void;
  /** Server hat einen Stroke mit dieser cid angelegt (Undo/Redo der Anlage). */
  strokeCommitted: (cid: string, id: string) => void;
  /** Stroke anlegen / Felder ändern / löschen — jeweils mit Undo/Redo. */
  commitStroke: (data: Record<string, unknown>) => void;
  modifyStroke: (id: string, data: Record<string, unknown>) => void;
  deleteStroke: (id: string) => void;
  // dots.ts
  /** Punkt-Panel beim Wechsel ins Punkt-Werkzeug auf die aktuelle Phase setzen. */
  syncDotPanel: () => void;
  placeDot: (pos: LngLat2) => void;
  openDotSettings: (id: string) => void;
  // markers.ts
  placeMarker: (pos: LngLat2, tpl: MarkerTemplate) => void;
  startPlaceAt: (pos: LngLat2) => void;
  openEditPanel: (m: Marker) => Promise<void>;
  // favorites.ts
  reloadFavs: () => Promise<void>;
  // annots.ts
  renderAnnots: () => void;
  positionAnnots: () => void;
  openAnnotEditor: (id: string, isNew?: boolean) => void;
  annotVisHtml: (a: Pick<Annot, "phase_id" | "extra_phase_ids" | "zeus_released" | "zeus_until"> & { mb?: boolean }) => string;
  wireAnnotVis: (host: HTMLElement) => void;
  readAnnotVis: (host: HTMLElement, a: Annot | null) => Record<string, unknown>;
  starColorHtml: (cur: string) => string;
  wireStarColor: (host: HTMLElement) => void;
  readStarColor: (host: HTMLElement) => string;
  createAnnotAt: (pos: LngLat2) => void;
  // areas.ts
  refreshAreas: () => void;
  renderAreaBar: () => void;
  startAreaDraw: (aid: string) => void;
  setEditArea: (id: string | null) => void;
  canEditArea: (a: Annot | undefined) => boolean;
  // images.ts
  renderMapImages: () => void;
  positionImages: () => void;
  refreshImageRail: () => void;
}

const noop = (): void => {};
const noopAsync = async (): Promise<void> => {};

export function createUi(): PlanUi {
  return {
    refreshMarkers: noopAsync,
    refreshStrokes: noop,
    refreshDir: noop,
    redrawMarkersOnly: noop,
    refreshChains: noop,
    refreshStrokeVerts: noop,
    setEditStroke: noop,
    setEditMeasure: noop,
    editPts: () => undefined,
    refreshPeers: noop,
    resync: noopAsync,
    pushCmd: noop,
    doUndo: noop,
    doRedo: noop,
    resetPointer: noop,
    sampleElevation: () => null,
    renderTimeline: noop,
    applyPhase: noop,
    selectPhase: noop,
    selectPlayerPhase: noop,
    stepPhase: noop,
    startPresent: noop,
    addPlayerPhase: noopAsync,
    addSubPhase: noopAsync,
    patchPhaseTimes: noop,
    computeSpans: () => new Map(),
    toggleNotesWin: noop,
    repaintNotesTimes: noop,
    flyToPlace: () => false,
    listPlaces: () => [],
    belowTopbar: () => 54,
    placeNextToTool: noop,
    showTacLayer: noop,
    ensureOrbatCache: noopAsync,
    updateGrid: noop,
    setMode: noop,
    modeCursor: () => "",
    syncDragPan: noop,
    applyCaps: noop,
    positionLineDone: noop,
    redrawMeasure: noop,
    commitMeasure: noop,
    finishLine: noop,
    cancelLine: noop,
    refreshLineDraft: noop,
    renderMeasureX: noop,
    renderLineX: noop,
    strokeCommitted: noop,
    commitStroke: noop,
    modifyStroke: noop,
    deleteStroke: noop,
    syncDotPanel: noop,
    placeDot: noop,
    openDotSettings: noop,
    placeMarker: noop,
    startPlaceAt: noop,
    openEditPanel: noopAsync,
    reloadFavs: noopAsync,
    renderAnnots: noop,
    positionAnnots: noop,
    openAnnotEditor: noop,
    annotVisHtml: () => "",
    wireAnnotVis: noop,
    readAnnotVis: () => ({}),
    createAnnotAt: noop,
    starColorHtml: () => "",
    wireStarColor: noop,
    readStarColor: () => "",
    refreshAreas: noop,
    renderAreaBar: noop,
    startAreaDraw: noop,
    setEditArea: noop,
    canEditArea: () => false,
    renderMapImages: noop,
    positionImages: noop,
    refreshImageRail: noop,
  };
}

export type LineColor = PhaseLineStyle["colors"][number];

export interface PlanCtx {
  // ── feste Werte ──
  root: HTMLElement;
  planId: string;
  me: Me;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  snap: any;
  mapId: string;
  cal: Calibration | null;
  markers: Map<string, Marker>;
  strokes: Map<string, Stroke>;
  annots: Map<string, Annot>;
  images: Map<string, PlanImage>;
  placements: Map<string, ImagePlacement>;
  /** Phasen-Liste — wird nur in place verändert (push/splice/sort), nie neu zugewiesen. */
  phases: PhaseT[];
  projectId: string | null;
  myPlan: PlanItem | undefined;
  canEdit: boolean;
  isMB: boolean;
  canZeus: boolean;
  caps: { place: boolean; move: boolean; delete: boolean; draw: boolean };
  lineColors: LineColor[];
  lineWidths: { width: number; isDefault: boolean }[];
  modCat: ModifierCatalog | null;
  subCatBySidc: Map<string, string>;
  nameBySidc: Map<string, string>;
  langKeyBySidc: Map<string, string>;
  /** Alle document/window-Listener der Plan-Ansicht hängen an diesem Signal (Abbau bei hashchange). */
  sig: AbortSignal;
  map: maplibregl.Map;
  socket: PlanSocket;
  peers: Map<string, Peer>;
  /** z. B. Notiz-Fenster bei Phasenwechsel */
  phaseListeners: (() => void)[];
  layerListeners: (() => void)[];
  tacKey: string;
  tacState: Record<string, { on?: boolean; op?: number }>;
  baseLayerVisible: Record<string, boolean>;
  /** Terrain-/Enfusion-Overlays müssen UNTER "strokes" liegen → warten, bis render.ts den Layer angelegt hat. */
  strokesLayer: { ready: Promise<void>; done: () => void };
  /** Stern-Dialog: Zeus-Freigabe bzw. „Danach Bereich zeichnen“ je cid, bis der Server den Pin bestätigt. */
  pendingStarZeus: Map<string, Record<string, unknown>>;
  pendingStarArea: Set<string>;
  model: PlanModel;
  ui: PlanUi;
  tools: Partial<Record<Mode, ToolHandlers>>;

  // ── veränderlicher Zustand (immer über ctx lesen/schreiben) ──
  mode: Mode;
  pending: MarkerTemplate | null;
  is3D: boolean;
  currentPhaseId: string;
  actAs: ActAs;
  lineColor: number;
  lineWidth: number;
  outOpacity: number;
  crossOpacity: number;
  personalScale: number;
  textScale: number;
  showUnitAiLabels: boolean;
  showMarkerInfo: boolean;
  tacLayers: TacLayer[];
  planOrbatCache: Orbat[];
  hoverLngLat: { lng: number; lat: number } | null;
  hoverMarkerId: string | null;
  // Linien / Lineal
  measureLines: MeasureLine[];
  measureActive: LngLat2[];
  measureCursor: LngLat2 | null;
  measurePhaseId: string | null;
  editMeasureId: string | null;
  editStrokeId: string | null;
  linePts: LngLat2[];
  lineCursor: LngLat2 | null; // Mauszeiger für die Vorschau-Linie
  linePhaseId: string | null;
  vertTouchDrag: boolean;
  // Marker setzen: erst Position klicken, dann Wizard (awaitingPos = warte auf den Positions-Klick)
  chainGroup: number | null;
  chainIndex: number;
  awaitingPos: boolean;
  pendingPos: LngLat2 | null;
  /** Marker wird gerade gezogen */
  dragId: string | null;
  // Annotationen / Bereiche / Bilder
  annotResizingId: string | null;
  pendingAnnotCid: string | null;
  areaDraft: { aid: string; pts: LngLat2[] } | null;
  areaCursor: LngLat2 | null;
  editAreaId: string | null;
  imgResizingId: string | null;
}
