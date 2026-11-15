// Bereich um einen Pin: offene Linie oder (geschlossen) schraffierte Fläche.
// Gehört zur Annotation (Feld ``area``), folgt deren Sichtbarkeit und wandert beim Verschieben des Sterns mit.
// Schraffur-Muster, Ring und Flächengröße kommen aus mapAreas.ts (gemeinsam mit benannten Flächen und der
// öffentlichen Ansicht). Die Größe (Fläche bzw. Länge) steht klein unter dem Stern (updateAreaSizes).
import type * as maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import { t } from "../i18n";
import { icon } from "../icons";
import { toast } from "../notify";
import { areaSizeText, DEFAULT_FILL_STRENGTH, ensureHatch, FILL_PATTERNS, normPattern, normStrength, ringOf } from "../mapAreas";
import { AREA_CLOSE_PX, AREA_COL, AREA_MAX_POINTS, type Annot, type AnnotArea, type Marker, type PlanCtx } from "./ctx";

export function initAreas(ctx: PlanCtx): void {
  const { map, socket, root, annots, markers, canEdit, caps, isMB, sig } = ctx;
  const { isNotesAnnot, annotOpacity, phaseOpacity } = ctx.model;
  // Besitzer eines Bereichs: Missionsbau-Stern (Annotation) oder Marker — beide haben ein Feld ``area``.
  const ownerOf = (id: string | null | undefined): Annot | Marker | undefined => (id ? annots.get(id) ?? markers.get(id) : undefined);
  const isAnnotId = (id: string): boolean => annots.has(id);
  const areaOf = (id: string | null | undefined): AnnotArea | null | undefined => ownerOf(id)?.area;
  const sendArea = (id: string, area: AnnotArea | null): void => {
    socket.send({ type: isAnnotId(id) ? "annotation.modify" : "marker.modify", id, data: { area } });
  };
  // ── Bereich um einen Pin: Linie oder (geschlossen) schraffierte Fläche ──
  // Gehört zur Annotation (Feld ``area``), folgt deren Sichtbarkeit und wandert beim Verschieben des Sterns mit.
  // Zeichnen: Linksklicks setzen Ecken, Klick auf den Startpunkt schließt die Fläche, ✓ / Enter / Rechtsklick
  // übernimmt eine offene Linie, Esc bricht ab. Bestehende Ecken: Bereich anklicken → Ecken ziehen.
  const areaBar = document.createElement("div");
  areaBar.className = "area-bar";
  areaBar.hidden = true;
  root.appendChild(areaBar);
  // Schraffur-Muster aus mapAreas.ts (dieselbe Implementierung wie für benannte Flächen und die öffentliche Ansicht)
  function ensureAreaLayers(): void {
    ensureHatch(map, AREA_COL.mb);
    ensureHatch(map, AREA_COL.all);
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
            "fill-pattern": ["get", "pat"],
            "fill-opacity": ["*", ["coalesce", ["get", "fo"], 0.25], ["get", "op"]],
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
            "line-color": ["get", "color"],
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
  // Farbe: eigene Bereichsfarbe, sonst Sternfarbe, sonst gelb (pink bei Missionsbau-Notizen)
  const areaColorOf = (o: Annot | Marker | undefined): string => {
    if (!o) return AREA_COL.all;
    if (o.area?.color) return o.area.color;
    if ("text" in o) return o.color || (isNotesAnnot(o) ? AREA_COL.mb : AREA_COL.all);
    return AREA_COL.all;
  };
  const ownerOpacity = (o: Annot | Marker): number => ("text" in o ? annotOpacity(o) : phaseOpacity(o));

  function areaFC(): GeoJSON.FeatureCollection {
    const feats: GeoJSON.Feature[] = [];
    for (const a of [...annots.values(), ...markers.values()]) {
      const ar = a.area;
      if (!ar || ar.pts.length < 2) continue;
      const op = ownerOpacity(a);
      if (op <= 0) continue;
      const col = areaColorOf(a);
      const pk = normPattern(ar.pattern);
      const props = {
        aid: a.id,
        mb: "text" in a && isNotesAnnot(a),
        op,
        sel: a.id === ctx.editAreaId,
        color: col,
        pat: ensureHatch(map, col, pk),
        fo: normStrength(ar.strength ?? DEFAULT_FILL_STRENGTH) / 100,
      };
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
      const color = areaColorOf(ownerOf(ctx.areaDraft.aid));
      const hot = nearFirst(ctx.areaDraft.pts, ctx.areaCursor);
      const line = [...ctx.areaDraft.pts, ...(ctx.areaCursor ? [hot ? ctx.areaDraft.pts[0] : ctx.areaCursor] : [])];
      if (line.length >= 2) feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: line }, properties: { color } });
      ctx.areaDraft.pts.forEach((p, i) =>
        feats.push({ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: { color, i, first: i === 0, hot: i === 0 && hot } }),
      );
    } else if (ctx.editAreaId) {
      const a = ownerOf(ctx.editAreaId);
      const color = areaColorOf(a);
      (a?.area?.pts ?? []).forEach((p, i) =>
        feats.push({ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: { color, i, first: false, hot: false } }),
      );
    }
    return { type: "FeatureCollection", features: feats };
  }
  // Größe unter dem Stern: Fläche (geschlossen) bzw. Länge (offene Linie); beim Zeichnen live inkl. Mauszeiger.
  function sizeTextOf(aid: string): string {
    const d = ctx.areaDraft;
    if (d && d.aid === aid) {
      if (!d.pts.length) return "";
      const hot = nearFirst(d.pts, ctx.areaCursor);
      return hot ? areaSizeText(d.pts, true, ctx.cal) : areaSizeText(ctx.areaCursor ? [...d.pts, ctx.areaCursor] : d.pts, false, ctx.cal);
    }
    const ar = areaOf(aid);
    return ar && ar.pts.length >= 2 ? areaSizeText(ar.pts, ar.closed, ctx.cal) : "";
  }
  function updateAreaSizes(): void {
    root.querySelectorAll<HTMLElement>("#annots [data-area-size]").forEach((el) => {
      const txt = sizeTextOf(el.dataset.areaSize ?? "");
      if (el.textContent !== txt) el.textContent = txt;
      el.hidden = !txt;
    });
  }
  function refreshAreas(): void {
    try {
      ensureAreaLayers();
      (map.getSource("pin-areas") as GeoJSONSource).setData(areaFC());
      (map.getSource("pin-area-edit") as GeoJSONSource).setData(areaEditFC());
    } catch {
      /* Karte/Stil noch nicht geladen – folgt mit "load" */
    }
    updateAreaSizes();
    positionAreaBar();
  }
  map.on("load", () => refreshAreas());
  map.on("style.load", () => refreshAreas());
  // Leiste (✓ übernehmen / neu zeichnen / entfernen) am letzten bzw. ersten Punkt
  function positionAreaBar(): void {
    const pts = ctx.areaDraft ? ctx.areaDraft.pts : ctx.editAreaId ? areaOf(ctx.editAreaId)?.pts ?? [] : [];
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
        `<button data-area-style title="${t("area.style")}">${icon("settings", 16)}</button>` +
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
    areaBar.querySelector("[data-area-style]")?.addEventListener("click", () => toggleStylePanel());
    areaBar.querySelector("[data-area-del]")?.addEventListener("click", () => {
      const id = ctx.editAreaId;
      if (!id) return;
      setEditArea(null);
      const o = ownerOf(id);
      if (o) o.area = null;
      sendArea(id, null);
      refreshAreas();
    });
  }
  // ── Stil des Bereichs bearbeiten: Farbe, Füllmuster, Stärke (Stern und Marker) ──
  const stylePanel = document.createElement("div");
  stylePanel.className = "area-style card";
  stylePanel.hidden = true;
  areaBar.appendChild(stylePanel);
  function toggleStylePanel(): void {
    if (!stylePanel.hidden) {
      stylePanel.hidden = true;
      return;
    }
    const id = ctx.editAreaId;
    const o = ownerOf(id);
    if (!id || !o?.area) return;
    const ar = o.area;
    const closed = ar.closed && ar.pts.length >= 3;
    const strength0 = normStrength(ar.strength ?? DEFAULT_FILL_STRENGTH);
    stylePanel.innerHTML =
      `<label class="chk-lbl">${t("area.color")}<input type="color" data-as-color value="${areaColorOf(o)}" /></label>` +
      (closed
        ? `<label class="chk-lbl">${t("areaName.pattern")}<select data-as-pattern>${FILL_PATTERNS.map(
            (p) => `<option value="${p}" ${normPattern(ar.pattern) === p ? "selected" : ""}>${t("areaName.pat." + p)}</option>`,
          ).join("")}</select></label>` +
          `<label class="chk-lbl">${t("areaName.strength")}<input type="range" min="5" max="100" step="5" data-as-strength value="${strength0}" /> <span data-as-strengthv>${strength0}%</span></label>`
        : "");
    stylePanel.hidden = false;
    const apply = (save: boolean): void => {
      const cur = ownerOf(id);
      if (!cur?.area) return;
      cur.area = {
        ...cur.area,
        color: stylePanel.querySelector<HTMLInputElement>("[data-as-color]")!.value,
        ...(closed
          ? {
              pattern: normPattern(stylePanel.querySelector<HTMLSelectElement>("[data-as-pattern]")?.value),
              strength: normStrength(stylePanel.querySelector<HTMLInputElement>("[data-as-strength]")?.value),
            }
          : {}),
      };
      const sv = stylePanel.querySelector<HTMLElement>("[data-as-strengthv]");
      if (sv) sv.textContent = `${cur.area.strength}%`;
      refreshAreas();
      if (save) sendArea(id, cur.area);
    };
    stylePanel.querySelectorAll<HTMLElement>("input,select").forEach((el) => {
      el.addEventListener("input", () => apply(false)); // live anzeigen
      el.addEventListener("change", () => apply(true)); // beim Loslassen speichern
    });
  }
  const canEditArea = (o: Annot | Marker | undefined): boolean => {
    if (!o || !canEdit || !caps.move) return false;
    if ("text" in o) return isMB || !isNotesAnnot(o);
    return !o.locked;
  };
  function startAreaDraw(aid: string): void {
    if (!canEditArea(ownerOf(aid))) return;
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
    const a = ownerOf(d.aid);
    // Stil eines bestehenden Bereichs beim Neuzeichnen behalten
    const old = a?.area;
    const styled: AnnotArea = {
      ...area,
      ...(old?.color ? { color: old.color } : {}),
      ...(old?.pattern ? { pattern: old.pattern } : {}),
      ...(old?.strength != null ? { strength: old.strength } : {}),
    };
    if (a) a.area = styled; // sofort zeigen, Server bestätigt per upsert
    sendArea(d.aid, styled);
    refreshAreas();
  }
  function setEditArea(id: string | null): void {
    ctx.editAreaId = id;
    stylePanel.hidden = true;
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
    updateAreaSizes();
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
    if (!aid || !canEditArea(ownerOf(aid))) return;
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
    const a = ctx.editAreaId ? ownerOf(ctx.editAreaId) : undefined;
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
      sendArea(a.id, a.area ?? null);
    };
    map.on("mousemove", onMove);
    document.addEventListener("mouseup", onUp, { once: true, signal: sig });
  });
  // Marker wird gezogen: sein Bereich folgt live (der Server verschiebt ihn beim Speichern um dasselbe Delta)
  const shiftMarkerArea = (m: Marker, lng: number, lat: number): void => {
    if (!m.area) return;
    const dx = lng - m.world_x;
    const dy = lat - m.world_y;
    m.area = { ...m.area, pts: m.area.pts.map((p) => [p[0] + dx, p[1] + dy] as [number, number]) };
    refreshAreas();
  };
  ctx.tools.area = { click: (e) => areaClick([e.lngLat.lng, e.lngLat.lat]) };
  Object.assign(ctx.ui, { refreshAreas, renderAreaBar, startAreaDraw, setEditArea, canEditArea, shiftMarkerArea });
}
