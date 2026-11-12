// Bereich um einen Pin: offene Linie oder (geschlossen) schraffierte Fläche.
// Gehört zur Annotation (Feld ``area``), folgt deren Sichtbarkeit und wandert beim Verschieben des Sterns mit.
// Die Hilfen für Schraffur-Muster und Flächen-Layer (hatchImage, ensureAreaLayers, areaFC, ringOf) sind hier
// gebündelt, damit weitere Flächen-Funktionen (z. B. Flächengröße, benannte Flächen) sie nutzen können.
import type * as maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import { t } from "../i18n";
import { icon } from "../icons";
import { toast } from "../notify";
import { AREA_CLOSE_PX, AREA_COL, AREA_MAX_POINTS, type Annot, type PlanCtx } from "./ctx";

export function initAreas(ctx: PlanCtx): void {
  const { map, socket, root, annots, canEdit, caps, isMB, sig } = ctx;
  const { isNotesAnnot, annotOpacity } = ctx.model;
  // ── Bereich um einen Pin: Linie oder (geschlossen) schraffierte Fläche ──
  // Gehört zur Annotation (Feld ``area``), folgt deren Sichtbarkeit und wandert beim Verschieben des Sterns mit.
  // Zeichnen: Linksklicks setzen Ecken, Klick auf den Startpunkt schließt die Fläche, ✓ / Enter / Rechtsklick
  // übernimmt eine offene Linie, Esc bricht ab. Bestehende Ecken: Bereich anklicken → Ecken ziehen.
  const areaBar = document.createElement("div");
  areaBar.className = "area-bar";
  areaBar.hidden = true;
  root.appendChild(areaBar);
  const hatchImage = (color: string): ImageData => {
    const n = 16;
    const cv = document.createElement("canvas");
    cv.width = cv.height = n;
    const g = cv.getContext("2d")!;
    g.strokeStyle = color;
    g.lineWidth = 2.2;
    g.beginPath();
    for (const o of [-n, 0, n]) {
      g.moveTo(o, n);
      g.lineTo(o + n, 0);
    }
    g.stroke();
    return g.getImageData(0, 0, n, n);
  };
  function ensureAreaLayers(): void {
    if (!map.hasImage("hatch-mb")) map.addImage("hatch-mb", hatchImage(AREA_COL.mb));
    if (!map.hasImage("hatch-all")) map.addImage("hatch-all", hatchImage(AREA_COL.all));
    const before = map.getLayer("strokes") ? "strokes" : undefined;
    if (!map.getSource("pin-areas")) {
      map.addSource("pin-areas", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer(
        {
          id: "pin-area-fill",
          type: "fill",
          source: "pin-areas",
          filter: ["==", ["geometry-type"], "Polygon"],
          paint: {
            "fill-pattern": ["case", ["get", "mb"], "hatch-mb", "hatch-all"],
            "fill-opacity": ["*", 0.25, ["get", "op"]],
          },
        },
        before,
      );
      map.addLayer(
        {
          id: "pin-area-line",
          type: "line",
          source: "pin-areas",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": ["case", ["get", "mb"], AREA_COL.mb, AREA_COL.all],
            "line-width": ["case", ["get", "sel"], 3.5, 2.5],
            "line-opacity": ["*", 0.5, ["get", "op"]],
          },
        },
        before,
      );
    }
    if (!map.getSource("pin-area-edit")) {
      map.addSource("pin-area-edit", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "pin-area-draft",
        type: "line",
        source: "pin-area-edit",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: { "line-color": ["get", "color"], "line-width": 2.5, "line-dasharray": [2, 1.5] },
      });
      map.addLayer({
        id: "pin-area-verts",
        type: "circle",
        source: "pin-area-edit",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": ["case", ["get", "hot"], 9, ["get", "first"], 7, 5.5],
          "circle-color": ["case", ["get", "hot"], "#3ddc84", "#ffffff"],
          "circle-stroke-color": ["get", "color"],
          "circle-stroke-width": 2.5,
        },
      });
    }
  }
  const areaColorOf = (a: Annot | undefined): string => (a && isNotesAnnot(a) ? AREA_COL.mb : AREA_COL.all);
  const ringOf = (pts: [number, number][]): [number, number][] => [...pts, pts[0]];
  function areaFC(): GeoJSON.FeatureCollection {
    const feats: GeoJSON.Feature[] = [];
    for (const a of annots.values()) {
      const ar = a.area;
      if (!ar || ar.pts.length < 2) continue;
      const op = annotOpacity(a);
      if (op <= 0) continue;
      const props = { aid: a.id, mb: isNotesAnnot(a), op, sel: a.id === ctx.editAreaId };
      if (ar.closed && ar.pts.length >= 3) {
        feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [ringOf(ar.pts)] }, properties: props });
        feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: ringOf(ar.pts) }, properties: props });
      } else {
        feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: ar.pts }, properties: props });
      }
    }
    return { type: "FeatureCollection", features: feats };
  }
  // Nähe zum Startpunkt in Bildschirm-Pixeln (Schließen der Fläche)
  const nearFirst = (pts: [number, number][], p: [number, number] | null): boolean => {
    if (!p || pts.length < 3) return false;
    const a = map.project(pts[0]);
    const b = map.project(p);
    return Math.hypot(a.x - b.x, a.y - b.y) <= AREA_CLOSE_PX;
  };
  function areaEditFC(): GeoJSON.FeatureCollection {
    const feats: GeoJSON.Feature[] = [];
    if (ctx.areaDraft) {
      const color = areaColorOf(annots.get(ctx.areaDraft.aid));
      const hot = nearFirst(ctx.areaDraft.pts, ctx.areaCursor);
      const line = [...ctx.areaDraft.pts, ...(ctx.areaCursor ? [hot ? ctx.areaDraft.pts[0] : ctx.areaCursor] : [])];
      if (line.length >= 2) feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: line }, properties: { color } });
      ctx.areaDraft.pts.forEach((p, i) =>
        feats.push({ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: { color, i, first: i === 0, hot: i === 0 && hot } }),
      );
    } else if (ctx.editAreaId) {
      const a = annots.get(ctx.editAreaId);
      const color = areaColorOf(a);
      (a?.area?.pts ?? []).forEach((p, i) =>
        feats.push({ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: { color, i, first: false, hot: false } }),
      );
    }
    return { type: "FeatureCollection", features: feats };
  }
  function refreshAreas(): void {
    try {
      ensureAreaLayers();
      (map.getSource("pin-areas") as GeoJSONSource).setData(areaFC());
      (map.getSource("pin-area-edit") as GeoJSONSource).setData(areaEditFC());
    } catch {
      /* Karte/Stil noch nicht geladen – folgt mit "load" */
    }
    positionAreaBar();
  }
  map.on("load", () => refreshAreas());
  map.on("style.load", () => refreshAreas());
  // Leiste (✓ übernehmen / neu zeichnen / entfernen) am letzten bzw. ersten Punkt
  function positionAreaBar(): void {
    const pts = ctx.areaDraft ? ctx.areaDraft.pts : ctx.editAreaId ? annots.get(ctx.editAreaId)?.area?.pts ?? [] : [];
    const anchor = ctx.areaDraft ? pts[pts.length - 1] : pts[0];
    if (!anchor || (ctx.areaDraft && pts.length < 2)) {
      areaBar.hidden = true;
      return;
    }
    const p = map.project(anchor);
    const mr = map.getContainer().getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    areaBar.hidden = false;
    areaBar.style.left = `${mr.left - rr.left + p.x + 14}px`;
    areaBar.style.top = `${mr.top - rr.top + p.y - 14}px`;
  }
  map.on("move", () => {
    if (ctx.areaDraft || ctx.editAreaId) positionAreaBar();
  });
  function renderAreaBar(): void {
    if (ctx.areaDraft) {
      areaBar.innerHTML =
        `<button class="area-ok" data-area-ok title="${t("area.finishOpen")}">${icon("check", 16)}</button>` +
        `<button data-area-cancel title="${t("common.cancel")}">${icon("x", 16)}</button>`;
    } else if (ctx.editAreaId) {
      areaBar.innerHTML =
        `<button class="area-ok" data-area-done title="${t("area.done")}">${icon("check", 16)}</button>` +
        `<button data-area-redraw title="${t("area.redraw")}">${icon("line", 16)}</button>` +
        `<button class="area-del" data-area-del title="${t("area.remove")}">${icon("trash", 16)}</button>`;
    } else areaBar.innerHTML = "";
    areaBar.querySelector("[data-area-ok]")?.addEventListener("click", () => commitArea(false));
    areaBar.querySelector("[data-area-cancel]")?.addEventListener("click", () => ctx.ui.setMode("move"));
    areaBar.querySelector("[data-area-done]")?.addEventListener("click", () => setEditArea(null));
    areaBar.querySelector("[data-area-redraw]")?.addEventListener("click", () => {
      const id = ctx.editAreaId;
      if (id) startAreaDraw(id);
    });
    areaBar.querySelector("[data-area-del]")?.addEventListener("click", () => {
      const id = ctx.editAreaId;
      if (!id) return;
      setEditArea(null);
      socket.send({ type: "annotation.modify", id, data: { area: null } });
    });
  }
  const canEditArea = (a: Annot | undefined): boolean => !!a && canEdit && !!caps.move && (isMB || !isNotesAnnot(a));
  function startAreaDraw(aid: string): void {
    if (!canEditArea(annots.get(aid))) return;
    ctx.editAreaId = null;
    ctx.ui.setMode("area");
    ctx.areaDraft = { aid, pts: [] };
    ctx.areaCursor = null;
    renderAreaBar();
    refreshAreas();
    toast(t("area.hint"), { kind: "info", timeout: 6000 });
  }
  function commitArea(closed: boolean): void {
    const d = ctx.areaDraft;
    if (!d) return;
    const pts = d.pts;
    ctx.areaDraft = null;
    ctx.areaCursor = null;
    ctx.ui.setMode("move");
    if (pts.length < 2) return;
    const area = { pts, closed: closed && pts.length >= 3 };
    const a = annots.get(d.aid);
    if (a) a.area = area; // sofort zeigen, Server bestätigt per upsert
    socket.send({ type: "annotation.modify", id: d.aid, data: { area } });
    refreshAreas();
  }
  function setEditArea(id: string | null): void {
    ctx.editAreaId = id;
    renderAreaBar();
    refreshAreas();
  }
  // Klick in der Karte während des Zeichnens
  function areaClick(p: [number, number]): void {
    if (!ctx.areaDraft) return;
    if (nearFirst(ctx.areaDraft.pts, p)) {
      commitArea(true); // Schleife geschlossen → Fläche
      return;
    }
    if (ctx.areaDraft.pts.length >= AREA_MAX_POINTS) return;
    ctx.areaDraft.pts.push(p);
    refreshAreas();
  }
  map.on("mousemove", (e) => {
    if (ctx.mode !== "area" || !ctx.areaDraft) return;
    ctx.areaCursor = [e.lngLat.lng, e.lngLat.lat];
    try {
      (map.getSource("pin-area-edit") as GeoJSONSource).setData(areaEditFC());
    } catch {
      /* noch nicht geladen */
    }
  });
  map.on("contextmenu", (e) => {
    if (ctx.mode !== "area" || !ctx.areaDraft) return;
    e.preventDefault();
    commitArea(false); // Rechtsklick übernimmt als offene Linie
  });
  document.addEventListener(
    "keydown",
    (ev) => {
      if (!ctx.areaDraft && !ctx.editAreaId) return;
      const tag = (ev.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (ev.key === "Escape") {
        ev.stopPropagation();
        if (ctx.areaDraft) ctx.ui.setMode("move");
        else setEditArea(null);
      } else if (ev.key === "Enter" && ctx.areaDraft) {
        ev.preventDefault();
        commitArea(false);
      }
    },
    { capture: true, signal: sig },
  );
  // Bestehenden Bereich anklicken → Ecken bearbeiten
  const pickArea = (e: maplibregl.MapLayerMouseEvent): void => {
    if (ctx.mode !== "move" && ctx.mode !== "markermove") return;
    const aid = e.features?.[0]?.properties?.aid as string | undefined;
    if (!aid || !canEditArea(annots.get(aid))) return;
    e.preventDefault();
    setEditArea(aid);
  };
  map.on("click", "pin-area-fill", pickArea);
  map.on("click", "pin-area-line", pickArea);
  map.on("mouseenter", "pin-area-verts", () => {
    if (ctx.editAreaId) map.getCanvas().style.cursor = "grab";
  });
  map.on("mouseleave", "pin-area-verts", () => (map.getCanvas().style.cursor = ctx.ui.modeCursor()));
  map.on("mousedown", "pin-area-verts", (e) => {
    const a = ctx.editAreaId ? annots.get(ctx.editAreaId) : undefined;
    const idx = e.features?.[0]?.properties?.i as number | undefined;
    if (!a?.area || idx == null || ctx.areaDraft) return;
    e.preventDefault();
    const pts = a.area.pts;
    map.dragPan.disable();
    map.getCanvas().style.cursor = "grabbing";
    const onMove = (ev: maplibregl.MapMouseEvent) => {
      pts[idx] = [ev.lngLat.lng, ev.lngLat.lat];
      refreshAreas();
    };
    const onUp = () => {
      map.off("mousemove", onMove);
      ctx.ui.syncDragPan();
      map.getCanvas().style.cursor = ctx.ui.modeCursor();
      socket.send({ type: "annotation.modify", id: a.id, data: { area: a.area } });
    };
    map.on("mousemove", onMove);
    document.addEventListener("mouseup", onUp, { once: true, signal: sig });
  });
  ctx.tools.area = { click: (e) => areaClick([e.lngLat.lng, e.lngLat.lat]) };
  Object.assign(ctx.ui, { refreshAreas, renderAreaBar, startAreaDraw, setEditArea, canEditArea });
}
