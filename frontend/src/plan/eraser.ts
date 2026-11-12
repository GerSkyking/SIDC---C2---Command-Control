// Radierer: Kreis mit einstellbarem Radius (Bildschirm-Pixel) — löscht beim Klicken/Ziehen alles im Kreis:
// Marker, Phasenlinien, Messlinien.
import { t } from "../i18n";
import { lngLatToWorld } from "../sidc/sidc";
import type { PlanCtx } from "./ctx";
import { fmtDist, polyHit } from "./geo";

export function initEraser(ctx: PlanCtx): void {
  const { map, socket, root, strokes, markers, caps, cal, sig } = ctx;
  const { multiPhaseOpacity, tacOpacity, phaseOpacity, measureVisible } = ctx.model;
  const eraserRing = root.querySelector<HTMLDivElement>("#eraserRing")!;
  // ── Radierer: Kreis mit einstellbarem Radius (Bildschirm-Pixel) ───────
  // Löscht beim Klicken/Ziehen alles im Kreis: Marker, Phasenlinien, Messlinien.
  const ERASER_KEY = "sidc_eraser_r";
  let eraserR = (() => {
    const v = Number(localStorage.getItem(ERASER_KEY));
    return v >= 8 && v <= 150 ? v : 24;
  })();
  let erasing = false;
  let eraseDownAt = 0;
  const eraserSizeIn = root.querySelector<HTMLInputElement>("#eraserSize")!;
  const eraserInfo = root.querySelector<HTMLDivElement>("#eraserInfo")!;
  const updateEraserUi = () => {
    eraserSizeIn.value = String(eraserR);
    eraserRing.style.width = eraserRing.style.height = `${eraserR * 2}px`;
    // Durchmesser des Kreises in Kartenmetern (an der Kartenmitte)
    const c = map.project(map.getCenter());
    const q = map.unproject([c.x + eraserR * 2, c.y]);
    const a = lngLatToWorld(cal, map.getCenter().lng, map.getCenter().lat);
    const b = lngLatToWorld(cal, q.lng, q.lat);
    eraserInfo.textContent = `${t("erase.diameter")}: ${fmtDist(Math.hypot(b[0] - a[0], b[1] - a[1]))}`;
  };
  updateEraserUi();
  eraserSizeIn.addEventListener("input", () => {
    eraserR = Number(eraserSizeIn.value);
    try {
      localStorage.setItem(ERASER_KEY, String(eraserR));
    } catch {
      /* ignore */
    }
    updateEraserUi();
  });
  map.on("zoom", () => ctx.mode === "erase" && updateEraserUi());
  const erasedIds = new Set<string>(); // schon gesendet, Server-Antwort steht noch aus
  const eraseAt = (px: number, py: number) => {
    const once = (id: string): boolean => {
      if (erasedIds.has(id)) return false;
      erasedIds.add(id);
      setTimeout(() => erasedIds.delete(id), 3000);
      return true;
    };
    if (caps.draw)
      for (const s of strokes.values()) {
        if (multiPhaseOpacity(s.phase_id, s.extra_phase_ids) * tacOpacity(null, s.layer_id) <= 0) continue;
        const r = eraserR + Math.max(2, s.width) / 2;
        if (polyHit(px, py, s.points.map((p) => map.project(p)), r) && once(s.id))
          socket.send({ type: "stroke.delete", id: s.id });
      }
    if (caps.delete)
      for (const m of markers.values()) {
        if (m.released || m.locked || phaseOpacity(m) <= 0) continue;
        const p = map.project([m.world_x, m.world_y]);
        if (Math.hypot(p.x - px, p.y - py) <= eraserR + 8 && once(m.id)) socket.send({ type: "marker.delete", id: m.id });
      }
    const hitIds = ctx.measureLines
      .filter((ml) => measureVisible(ml) && polyHit(px, py, ml.pts.map((p) => map.project(p)), eraserR))
      .map((ml) => ml.id);
    if (hitIds.length) {
      ctx.measureLines = ctx.measureLines.filter((x) => !hitIds.includes(x.id));
      if (ctx.editMeasureId && hitIds.includes(ctx.editMeasureId)) ctx.ui.setEditMeasure(null);
      ctx.ui.redrawMeasure();
    }
  };
  map.on("mousedown", (e) => {
    if (ctx.mode !== "erase" || e.originalEvent.button !== 0) return;
    erasing = true;
    eraseDownAt = Date.now();
    eraseAt(e.point.x, e.point.y);
  });
  map.on("mousemove", (e) => {
    if (ctx.mode !== "erase") return;
    const rr = root.getBoundingClientRect();
    eraserRing.hidden = false;
    eraserRing.style.left = `${e.originalEvent.clientX - rr.left}px`;
    eraserRing.style.top = `${e.originalEvent.clientY - rr.top}px`;
    if (erasing) eraseAt(e.point.x, e.point.y);
  });
  document.addEventListener("mouseup", () => (erasing = false), { signal: sig });
  // Touch: Radierer folgt dem Finger; ein zweiter Finger bricht ab (Karte navigieren)
  map.on("touchstart", (e) => {
    if (ctx.mode !== "erase") return;
    if (e.points.length !== 1) {
      erasing = false;
      return;
    }
    erasing = true;
    eraseDownAt = Date.now();
    eraseAt(e.point.x, e.point.y);
  });
  map.on("touchmove", (e) => {
    if (ctx.mode !== "erase" || e.points.length !== 1) return;
    const tc = e.originalEvent.touches[0];
    const rr = root.getBoundingClientRect();
    eraserRing.hidden = false;
    eraserRing.style.left = `${tc.clientX - rr.left}px`;
    eraserRing.style.top = `${tc.clientY - rr.top}px`;
    if (erasing) eraseAt(e.point.x, e.point.y);
  });
  const touchEraseEnd = () => {
    erasing = false;
    eraserRing.hidden = true;
  };
  document.addEventListener("touchend", touchEraseEnd, { signal: sig });
  document.addEventListener("touchcancel", touchEraseEnd, { signal: sig });
  map.getCanvas().addEventListener("mouseleave", () => (eraserRing.hidden = true));
  ctx.tools.erase = {
    click: (e) => {
      // Mausklick wurde schon bei mousedown radiert; hier nur noch der Touch-Tipp.
      if (Date.now() - eraseDownAt > 500) eraseAt(e.point.x, e.point.y);
    },
  };
}
