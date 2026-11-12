// Karten-Interaktion, die alle Werkzeuge betrifft:
//  - initContextMenu: Rechtsklick bricht laufende Aktionen ab bzw. öffnet im Karten-Werkzeug das Werkzeug-Menü
//  - initMapClicks: zentraler Karten-Klick — erst die gemeinsame Linien-/Messlinien-Auswahl, dann der Klick des
//    aktiven Werkzeugs aus ctx.tools[mode]; Escape bricht ab. Muss als LETZTES initialisiert werden, weil die
//    Layer-Klicks der Module (Marker, Linien, Bereiche) vorher per preventDefault zugreifen.
import type * as maplibregl from "maplibre-gl";
import { esc } from "../esc";
import { t } from "../i18n";
import { icon } from "../icons";
import type { PlanCtx } from "./ctx";

export function initContextMenu(ctx: PlanCtx): void {
  const { map, caps, sig } = ctx;
  // Rechtsklick bricht ab: Linien-Bearbeiten / laufende Linie / Marker-Linie
  map.on("contextmenu", (e) => {
    if (ctx.editStrokeId || ctx.editMeasureId) {
      e.preventDefault();
      ctx.ui.setEditStroke(null);
      ctx.ui.setEditMeasure(null); // Bearbeiten abbrechen
    } else if (ctx.mode === "line" && ctx.linePts.length) {
      e.preventDefault();
      ctx.ui.cancelLine(); // laufende Linie verwerfen, NICHT setzen
    } else if (ctx.mode === "measure" && ctx.measureActive.length) {
      e.preventDefault();
      ctx.measureActive = []; // laufende Messlinie verwerfen (wie beim Zeichnen)
      ctx.measureCursor = null;
      ctx.ui.redrawMeasure();
      ctx.ui.positionLineDone();
    } else if (ctx.mode === "place" && ctx.chainGroup != null && ctx.chainIndex > 0) {
      e.preventDefault();
      ctx.ui.setMode("move");
    } else if (ctx.mode === "move") {
      e.preventDefault();
      // Rechtsklick-Ziehen dreht die Karte — Menü nur bei einem echten Klick
      const oe = e.originalEvent as MouseEvent;
      if (!rightDown || Math.hypot(oe.clientX - rightDown.x, oe.clientY - rightDown.y) > 5) return;
      openCtxMenu(oe.clientX, oe.clientY, [e.lngLat.lng, e.lngLat.lat]);
    }
  });
  let rightDown: { x: number; y: number } | null = null;
  map.getCanvas().addEventListener("mousedown", (ev) => {
    rightDown = ev.button === 2 ? { x: ev.clientX, y: ev.clientY } : null;
  });

  // ── Rechtsklick-Menü im Karten-Werkzeug: alle anderen Werkzeuge ───────
  let ctxMenuEl: HTMLElement | null = null;
  const closeCtxMenu = () => {
    ctxMenuEl?.remove();
    ctxMenuEl = null;
  };
  function openCtxMenu(cx: number, cy: number, pos: [number, number]): void {
    closeCtxMenu();
    const items: { ic: string; label: string; ok: boolean; run: () => void }[] = [
      {
        ic: "marker",
        label: t("tool.marker").split(" – ")[0],
        ok: caps.place,
        run: () => {
          ctx.pending = null;
          ctx.ui.setMode("place");
          ctx.awaitingPos = false;
          ctx.ui.startPlaceAt(pos);
        },
      },
      {
        ic: "line",
        label: t("tool.line").split(" (")[0],
        ok: caps.draw,
        run: () => {
          ctx.ui.setMode("line");
          ctx.linePts.push(pos);
          ctx.ui.refreshLineDraft();
        },
      },
      {
        ic: "ruler",
        label: t("tool.measure").split(" – ")[0],
        ok: true,
        run: () => {
          ctx.ui.setMode("measure");
          ctx.measureActive.push(pos);
          ctx.ui.redrawMeasure();
        },
      },
      {
        ic: "textbox",
        label: t("tool.text").split(" (")[0],
        ok: caps.place,
        run: () => ctx.ui.createAnnotAt(pos),
      },
      { ic: "point", label: t("tool.point").split(" – ")[0], ok: true, run: () => ctx.ui.setMode("point") },
      { ic: "eraser", label: t("tool.erase").split(" – ")[0], ok: caps.delete || caps.draw, run: () => ctx.ui.setMode("erase") },
    ];
    const el = document.createElement("div");
    el.className = "ctx-menu";
    for (const it of items) {
      const b = document.createElement("button");
      b.innerHTML = `${icon(it.ic, 16)}<span>${esc(it.label)}</span>`;
      b.disabled = !it.ok;
      b.addEventListener("click", () => {
        closeCtxMenu();
        it.run();
      });
      el.appendChild(b);
    }
    document.body.appendChild(el);
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(cx, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(cy, window.innerHeight - r.height - 4))}px`;
    ctxMenuEl = el;
    const off = (ev: Event) => {
      if (ev instanceof MouseEvent && el.contains(ev.target as Node)) return;
      if (ev instanceof KeyboardEvent && ev.key !== "Escape") return;
      closeCtxMenu();
      document.removeEventListener("mousedown", off, true);
      document.removeEventListener("keydown", off, true);
      map.off("movestart", closeCtxMenu);
    };
    document.addEventListener("mousedown", off, { capture: true, signal: sig });
    document.addEventListener("keydown", off, { capture: true, signal: sig });
    map.once("movestart", closeCtxMenu);
  }
}

export function initMapClicks(ctx: PlanCtx): void {
  const { map, caps, sig } = ctx;
  map.on("click", (e) => {
    if ((e as { defaultPrevented?: boolean }).defaultPrevented) return;

    // Linie/Messlinie wählen: auch Klicks NAHE der Linie zählen (Radius ≈ Mauszeiger), nicht nur der Pixel darunter
    const pickIdle =
      ctx.mode === "move" || ctx.mode === "markermove" || (ctx.mode === "line" && !ctx.linePts.length) || (ctx.mode === "measure" && !ctx.measureActive.length);
    if (pickIdle) {
      const R = 12;
      const box: [maplibregl.PointLike, maplibregl.PointLike] = [
        [e.point.x - R, e.point.y - R],
        [e.point.x + R, e.point.y + R],
      ];
      const sid =
        ctx.mode !== "measure" && caps.draw
          ? (map.queryRenderedFeatures(box, { layers: ["strokes"] })[0]?.properties?.id as string | undefined)
          : undefined;
      const mid =
        !sid && ctx.mode !== "line"
          ? (map.queryRenderedFeatures(box, { layers: ["measure-line"] })[0]?.properties?.mid as string | undefined)
          : undefined;
      if (sid) {
        ctx.ui.setEditMeasure(null);
        ctx.ui.setEditStroke(sid);
        return;
      }
      if (mid && mid !== "__active") {
        ctx.ui.setEditStroke(null);
        ctx.ui.setEditMeasure(mid);
        return;
      }
      // Klick ins Leere beendet das Bearbeiten einer Linie/Messlinie
      if (ctx.editStrokeId || ctx.editMeasureId) {
        ctx.ui.setEditStroke(null);
        ctx.ui.setEditMeasure(null);
        return;
      }
    }

    if (ctx.editAreaId && (ctx.mode === "move" || ctx.mode === "markermove")) ctx.ui.setEditArea(null); // Klick daneben beendet die Ecken-Bearbeitung

    // Werkzeug-Klick: area (areas.ts), ref (starDialog.ts), text (annots.ts), erase (eraser.ts),
    // line/measure (strokes.ts), place (markers.ts)
    ctx.tools[ctx.mode]?.click?.(e);
  });

  document.addEventListener(
    "keydown",
    (ev) => {
      if (ev.key === "Escape") {
        if (ctx.mode === "line" && ctx.linePts.length) ctx.ui.cancelLine();
        else if (ctx.mode === "measure" && ctx.measureActive.length) {
          ctx.measureActive = [];
          ctx.measureCursor = null;
          ctx.ui.redrawMeasure();
          ctx.ui.positionLineDone();
        } else if (ctx.editStrokeId || ctx.editMeasureId) {
          ctx.ui.setEditStroke(null);
          ctx.ui.setEditMeasure(null);
        } else ctx.ui.setMode("move");
      }
    },
    { signal: sig },
  );
}
