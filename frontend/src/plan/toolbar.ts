// Werkzeugleiste: Werkzeug-Modus (setMode), Cursor, Karte fixieren/drehen, „Lock Rotation“,
// Tastenkürzel und Freischaltung der Werkzeuge nach Server-Rechten (applyCaps).
import { t } from "../i18n";
import { makeMovable } from "../movable";
import { toast } from "../notify";
import { actionForKey, openSettings } from "../settings";
import type { MarkerTemplate } from "../sidc/wizard";
import type { Marker, Mode, PlanCtx } from "./ctx";

export function initToolbar(ctx: PlanCtx): void {
  const { map, socket, root, planId, markers, canEdit, caps, projectId, sig } = ctx;
  // ── Werkzeugleiste ────────────────────────────────────────────────────
  const toolbar = root.querySelector<HTMLDivElement>("#toolbar")!;
  makeMovable(toolbar, { plan: planId, key: "toolbar" });
  const lineStylePanel = root.querySelector<HTMLDivElement>("#lineStyle")!;
  const mvLine = makeMovable(lineStylePanel, { plan: planId, key: "linestyle", pinnable: true });
  // Punkt-Menü: Farbe/Größe/Text/Phase/Layer für neue Punkte (wie das Linien-Menü)
  const dotStylePanel = root.querySelector<HTMLDivElement>("#dotStyle")!;
  const mvDot = makeMovable(dotStylePanel, { plan: planId, key: "dotstyle", pinnable: true });
  // Messen-Menü: Phase + taktischer Layer für neue Messlinien (Standard: aktuelle Phase)
  const measureStylePanel = root.querySelector<HTMLDivElement>("#measureStyle")!;
  const mvMeasure = makeMovable(measureStylePanel, { plan: planId, key: "measurestyle", pinnable: true });
  const eraserPanel = root.querySelector<HTMLDivElement>("#eraserPanel")!;
  const mvEraser = makeMovable(eraserPanel, { plan: planId, key: "eraser", pinnable: true });
  const eraserRing = root.querySelector<HTMLDivElement>("#eraserRing")!;
  const modeCursor = (m: Mode = ctx.mode): string =>
    m === "place" || m === "line" || m === "dot" || m === "point" || m === "measure" || m === "text" || m === "ref" || m === "area"
      ? "crosshair"
      : m === "erase"
        ? "crosshair"
        : m === "markermove"
          ? "move"
          : "";
  // „Lock Rotation": Karte bleibt immer genordet
  let rotLocked = localStorage.getItem("sidc_rotlock") === "1";
  map.on("rotate", () => {
    if (rotLocked && Math.abs(map.getBearing()) > 0.01) map.setBearing(0);
  });
  // Werkzeuge, bei denen ein Finger/die Maus nicht die Karte schiebt
  const fixesMap = () =>
    ctx.mode === "point" || ctx.mode === "line" || ctx.mode === "erase" || ctx.mode === "measure" || ctx.mode === "markermove";
  const syncDragPan = () => {
    if (fixesMap()) map.dragPan.disable();
    else map.dragPan.enable();
  };
  // Zwei Finger navigieren die Karte immer (auch bei fixierenden Werkzeugen); nach dem Loslassen wieder fixieren
  map.getCanvas().addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length >= 2) map.dragPan.enable();
    },
    { passive: true },
  );
  const reFix = (e: TouchEvent) => {
    if (e.touches.length === 0 && !ctx.vertTouchDrag) syncDragPan();
  };
  map.getCanvas().addEventListener("touchend", reFix, { passive: true });
  map.getCanvas().addEventListener("touchcancel", reFix, { passive: true });
  const setMode = (m: Mode) => {
    ctx.mode = m;
    toolbar.querySelectorAll("[data-mode]").forEach((b) =>
      b.classList.toggle("active", (b as HTMLElement).dataset.mode === m),
    );
    map.getCanvas().style.cursor = modeCursor(m);
    // Zeigen + Linie + Radierer + Messen + Marker-Verschieben: Karte fixieren
    syncDragPan();
    // Drehen nur im normalen Karten-Werkzeug (und nicht bei „Lock Rotation")
    if (m === "move" && !rotLocked) {
      map.dragRotate.enable();
      map.touchZoomRotate.enableRotation();
    } else {
      map.dragRotate.disable();
      map.touchZoomRotate.disableRotation();
    }
    if (m === "line" || m === "measure" || m === "area") map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
    eraserPanel.hidden = mvEraser.isPinned() ? false : m !== "erase";
    if (m !== "erase") eraserRing.hidden = true;
    toolbar.querySelector("#tool-marker")?.classList.toggle("active", m === "place");
    toolbar.querySelector("#tool-ref")?.classList.toggle("active", m === "ref");
    if (m !== "area" && ctx.areaDraft) {
      // Zeichnen eines Bereichs abgebrochen (anderes Werkzeug, Esc)
      ctx.areaDraft = null;
      ctx.areaCursor = null;
      ctx.ui.renderAreaBar();
      ctx.ui.refreshAreas();
    }
    lineStylePanel.hidden = mvLine.isPinned() ? false : m !== "line";
    dotStylePanel.hidden = mvDot.isPinned() ? false : m !== "dot";
    if (m === "dot") ctx.ui.syncDotPanel();
    if (measureStylePanel) {
      measureStylePanel.hidden = mvMeasure.isPinned() ? false : m !== "measure";
      if (m === "measure") {
        ctx.measurePhaseId = ctx.currentPhaseId || null;
        const mp = root.querySelector<HTMLSelectElement>("#mPhase");
        if (mp) mp.value = ctx.measurePhaseId ?? "";
        ctx.ui.renderMeasureX();
      }
    }
    if (m === "line") {
      ctx.linePhaseId = ctx.currentPhaseId || null;
      const lp = root.querySelector<HTMLSelectElement>("#lPhase");
      if (lp) lp.value = ctx.linePhaseId ?? "";
      ctx.ui.renderLineX();
    }
    if (m !== "line") {
      ctx.linePts = [];
      ctx.ui.refreshLineDraft();
    }
    if (m !== "move" && m !== "markermove" && m !== "line") ctx.ui.setEditStroke(null);
    if (m !== "measure") {
      ctx.measureActive = [];
      ctx.measureCursor = null;
      ctx.ui.redrawMeasure();
    }
    if (m !== "move" && m !== "markermove" && m !== "measure") ctx.ui.setEditMeasure(null);
    ctx.ui.positionLineDone();
    if (m !== "point") ctx.ui.resetPointer(); // Zeigen beenden (hud.ts)

    if (m !== "place") {
      ctx.pending = null;
      ctx.chainGroup = null;
      ctx.awaitingPos = false;
      ctx.pendingPos = null;
    }
  };
  toolbar.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => setMode(b.dataset.mode as Mode)),
  );
  // „Ort markieren": erst auf die Karte klicken (Stern erscheint), dann sagen, was dort ist/passieren soll; Esc bricht ab.
  toolbar.querySelector("#tool-ref")?.addEventListener("click", () => {
    if (!caps.place || !projectId) return;
    setMode("ref");
    toast(t("tool.refPlace"), { kind: "info", timeout: 3500 });
  });
  {
    const cb = root.querySelector<HTMLInputElement>("#rotLock")!;
    cb.checked = rotLocked;
    const apply = () => {
      if (rotLocked) {
        map.easeTo({ bearing: 0, duration: 300 });
        map.dragRotate.disable();
        map.touchZoomRotate.disableRotation();
        map.keyboard.disableRotation();
      } else {
        setMode(ctx.mode); // stellt Drehen je nach Werkzeug wieder her
        map.keyboard.enableRotation();
      }
    };
    cb.addEventListener("change", () => {
      rotLocked = cb.checked;
      try {
        localStorage.setItem("sidc_rotlock", rotLocked ? "1" : "0");
      } catch {
        /* ignore */
      }
      apply();
    });
    if (rotLocked) apply();
  }
  root.querySelector("#settingsBtn")!.addEventListener("click", openSettings);

  // Tastenkürzel (pro Nutzer, im Einstellungs-Menü umbelegbar).
  let clipboardMarker: MarkerTemplate | null = null;
  const markerToTpl = (m: Marker): MarkerTemplate => ({
    sidc: m.sidc,
    unit_text: m.unit_text,
    ai_text: m.ai_text,
    layer_id: m.layer_id,
    extra_phase_ids: m.extra_phase_ids ?? [],
    locked: false,
    timestamp_visible: true,
    rotation_degrees: m.rotation_degrees,
    is_multipoint: false,
    max_line_points: 0,
    orbat_node_id: m.orbat_node_id ?? null,
    orbat_strength: m.orbat_strength ?? 1,
    tint: m.tint || "",
  });
  const onHotkey = (ev: KeyboardEvent) => {
    if (document.querySelector(".edit-modal, .wiz-backdrop")) return; // Dialog offen
    const a = actionForKey(ev);
    if (!a) return;
    const tb = (id: string) => toolbar.querySelector<HTMLButtonElement>(id);
    const setModeBtn = (m: Mode) => {
      const b = toolbar.querySelector<HTMLButtonElement>(`[data-mode="${m}"]`);
      if (b && !b.disabled) setMode(m);
    };
    switch (a) {
      case "undo": if (canEdit) ctx.ui.doUndo(); break;
      case "redo": if (canEdit) ctx.ui.doRedo(); break;
      case "mapMove": setMode("move"); break;
      case "point": setModeBtn("point"); break;
      case "line": if (canEdit) setModeBtn("line"); break;
      case "dot": if (canEdit) setModeBtn("dot"); break;
      case "markermove": if (canEdit) setModeBtn("markermove"); break;
      case "measure": setModeBtn("measure"); break;
      case "erase": setModeBtn("erase"); break;
      case "text": if (canEdit) setModeBtn("text"); break;
      case "fav": if (canEdit && tb("#tool-fav") && !tb("#tool-fav")!.disabled) tb("#tool-fav")!.click(); break;
      case "place":
        ev.preventDefault();
        if (canEdit && tb("#tool-marker") && !tb("#tool-marker")!.disabled) tb("#tool-marker")!.click();
        break;
      case "phasePrev": ev.preventDefault(); ctx.ui.stepPhase(-1); break;
      case "phaseNext": ev.preventDefault(); ctx.ui.stepPhase(1); break;
      case "notes": ctx.ui.toggleNotesWin(); break;
      case "north": map.easeTo({ bearing: 0, duration: 400 }); break;
      case "copy":
      case "cut": {
        if (!ctx.hoverMarkerId) return;
        const m = markers.get(ctx.hoverMarkerId);
        if (!m || m.released) return;
        clipboardMarker = markerToTpl(m);
        toast(t("hot.copy"), { kind: "success", timeout: 1200 });
        if (a === "cut" && caps.delete && !m.locked) socket.send({ type: "marker.delete", id: m.id });
        break;
      }
      case "paste": {
        if (!clipboardMarker || !ctx.hoverLngLat || !caps.place) return;
        ctx.chainGroup = null;
        ctx.ui.placeMarker([ctx.hoverLngLat.lng, ctx.hoverLngLat.lat], clipboardMarker);
        break;
      }
    }
  };
  document.addEventListener("keydown", onHotkey, { signal: sig });
  function applyCaps(): void {
    const tb = root.querySelector("#toolbar");
    if (!tb) return;
    tb.querySelector<HTMLButtonElement>('[data-mode="line"]')?.toggleAttribute("disabled", !caps.draw);
    tb.querySelector<HTMLButtonElement>('[data-mode="dot"]')?.toggleAttribute("disabled", !caps.draw);
    tb.querySelector<HTMLButtonElement>('[data-mode="markermove"]')?.toggleAttribute("disabled", !caps.move);
    tb.querySelector<HTMLButtonElement>('[data-mode="erase"]')?.toggleAttribute("disabled", !caps.delete);
    tb.querySelector<HTMLButtonElement>('[data-mode="text"]')?.toggleAttribute("disabled", !caps.place);
    tb.querySelector<HTMLButtonElement>("#tool-marker")?.toggleAttribute("disabled", !caps.place);
    tb.querySelector<HTMLButtonElement>("#tool-ref")?.toggleAttribute("disabled", !caps.place || !projectId);
    tb.querySelector<HTMLButtonElement>("#tool-fav")?.toggleAttribute("disabled", !caps.place);
  }
  applyCaps();
  Object.assign(ctx.ui, { setMode, modeCursor, syncDragPan, applyCaps });
}
