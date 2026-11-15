// Bereich um einen Pin: offene Linie oder (geschlossen) schraffierte Fläche.
// Gehört zur Annotation (Feld ``area``), folgt deren Sichtbarkeit und wandert beim Verschieben des Sterns mit.
// Schraffur-Muster, Ring und Flächengröße kommen aus mapAreas.ts (gemeinsam mit benannten Flächen und der
// öffentlichen Ansicht). Die Größe (Fläche bzw. Länge) steht klein unter dem Stern (updateAreaSizes).
import type * as maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import { t } from "../i18n";
import { icon } from "../icons";
import { toast } from "../notify";
import { areaSizeText, DEFAULT_FILL_STRENGTH, ensureHatch, normPattern, normStrength, ringOf } from "../mapAreas";
import { patternPickerHtml, wirePatternPicker } from "./strokeArea";
import { wireColorBox } from "./dots";
import { hexToPacked, packedToHex } from "./geo";
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
            "line-width": ["+", ["coalesce", ["get", "w"], 2.5], ["case", ["get", "sel"], 1, 0]],
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
        id: "pin-area-mids",
        type: "circle",
        source: "pin-area-edit",
        filter: ["has", "mid"],
        paint: { "circle-radius": 3.5, "circle-color": "#ffffff", "circle-stroke-color": ["get", "color"], "circle-stroke-width": 1.5 },
      });
      map.addLayer({
        id: "pin-area-mids-hit",
        type: "circle",
        source: "pin-area-edit",
        filter: ["has", "mid"],
        paint: { "circle-radius": 11, "circle-color": "#000", "circle-opacity": 0 },
      });
      map.addLayer({
        id: "pin-area-verts",
        type: "circle",
        source: "pin-area-edit",
        filter: ["all", ["==", ["geometry-type"], "Point"], ["!", ["has", "mid"]]],
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
        w: ar.width ?? 2.5,
      };
      if (ar.closed && ar.pts.length >= 3) {
        if (ar.fill !== false) feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [ringOf(ar.pts)] }, properties: props });
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
      const pts = a?.area?.pts ?? [];
      pts.forEach((p, i) =>
        feats.push({ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: { color, i, first: false, hot: false } }),
      );
      // Mittelpunkte der Segmente: Ziehen fügt dort eine neue Ecke ein
      const closed = !!a?.area?.closed && pts.length >= 3;
      const segs = pts.length < 2 ? 0 : closed ? pts.length : pts.length - 1;
      for (let i = 0; i < segs; i++) {
        const p = pts[i];
        const q = pts[(i + 1) % pts.length];
        feats.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] },
          properties: { color, i, mid: 1 },
        });
      }
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
  // ── Einstellungen des Bereichs (Zahnrad): Farbe, Linienbreite, offen/geschlossen, Füllung, Muster, Stärke ──
  function toggleStylePanel(): void {
    const id = ctx.editAreaId;
    const o = ownerOf(id);
    if (!id || !o?.area) return;
    document.querySelector(".area-settings-dlg")?.remove();
    const before = cloneArea(o.area)!;
    const canClose = before.pts.length >= 3;
    const closed0 = before.closed && canClose;
    const strength0 = normStrength(before.strength ?? DEFAULT_FILL_STRENGTH);
    const widths = ctx.lineWidths.map((w) => w.width);
    if (!widths.includes(before.width ?? 2.5)) widths.push(before.width ?? 2.5);
    widths.sort((x, y) => x - y);
    const back = document.createElement("div");
    back.className = "edit-modal area-settings-dlg";
    back.innerHTML = `<div class="card" style="width:min(24rem,96vw)">
      <div class="row"><h1 style="flex:1;margin:0">${t("area.settings")}</h1><button class="icon-btn" data-x title="${t("common.close")}">${icon("x")}</button></div>
      <div class="chk-lbl">${t("area.color")}<div class="line-colors" data-as-colorbox></div></div>
      <label class="chk-lbl">${t("line.width")}<select data-as-width>${widths
        .map((w) => `<option value="${w}" ${w === (before.width ?? 2.5) ? "selected" : ""}>${w}</option>`)
        .join("")}</select></label>
      <label class="chk" style="margin-top:.5rem" title="${t("areaName.closedHint")}"><input type="checkbox" data-as-closed ${closed0 ? "checked" : ""} ${canClose ? "" : "disabled"}/> <span>${t("areaName.closed")}</span></label>
      <div data-as-fillblock ${closed0 ? "" : "hidden"}>
        <label class="chk" style="margin-top:.4rem" title="${t("tip.area.fill")}"><input type="checkbox" data-as-fill ${before.fill === false ? "" : "checked"}/> <span>${t("areaName.fill")}</span></label>
        <div data-as-fillopts ${before.fill === false ? "hidden" : ""}>
          <div class="chk-lbl">${t("areaName.pattern")}${patternPickerHtml(before.pattern, "data-as-pattern")}</div>
          <label class="chk-lbl ph-op" title="${t("tip.area.strength")}">${t("areaName.strength")}
            <input type="range" min="5" max="100" step="5" data-as-strength value="${strength0}" /> <span data-as-strengthv>${strength0}%</span></label>
        </div>
      </div>
      <div class="row" style="margin-top:.6rem"><button class="primary" data-as-save style="flex:1">${t("common.save")}</button></div>
    </div>`;
    document.body.appendChild(back);
    const q = <T extends HTMLElement>(sel: string): T | null => back.querySelector<T>(sel);
    let pickedColor = hexToPacked(areaColorOf(o));
    wireColorBox(q("[data-as-colorbox]")!, ctx.lineColors, () => pickedColor, (c) => (pickedColor = c));
    const readPattern = wirePatternPicker(back, "data-as-pattern");
    const closedIn = q<HTMLInputElement>("[data-as-closed]")!;
    const fillIn = q<HTMLInputElement>("[data-as-fill]")!;
    const sync = (): void => {
      q("[data-as-fillblock]")!.hidden = !closedIn.checked;
      q("[data-as-fillopts]")!.hidden = !fillIn.checked;
    };
    closedIn.addEventListener("change", sync);
    fillIn.addEventListener("change", sync);
    q<HTMLInputElement>("[data-as-strength]")!.addEventListener("input", (e) => {
      q("[data-as-strengthv]")!.textContent = `${(e.target as HTMLInputElement).value}%`;
    });
    const close = (): void => back.remove();
    back.addEventListener("mousedown", (e) => e.target === back && close());
    q("[data-x]")!.addEventListener("click", close);
    q("[data-as-save]")!.addEventListener("click", () => {
      const cur = ownerOf(id);
      if (!cur?.area) return close();
      const after: AnnotArea = {
        pts: cur.area.pts,
        closed: closedIn.checked && canClose,
        color: packedToHex(pickedColor),
        width: Number(q<HTMLSelectElement>("[data-as-width]")!.value) || 2.5,
        pattern: readPattern(),
        strength: normStrength(q<HTMLInputElement>("[data-as-strength]")!.value),
        ...(fillIn.checked ? {} : { fill: false }),
      };
      cur.area = after;
      sendArea(id, after);
      refreshAreas();
      if (JSON.stringify(before) !== JSON.stringify(after)) pushAreaCmd(id, before, cloneArea(after));
      close();
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
  // Rückgängig/Wiederholen für Änderungen am Bereich (Ecken, Einstellungen)
  const cloneArea = (ar: AnnotArea | null | undefined): AnnotArea | null =>
    ar ? { ...ar, pts: ar.pts.map((p) => [p[0], p[1]] as [number, number]) } : null;
  const pushAreaCmd = (id: string, before: AnnotArea | null, after: AnnotArea | null): void => {
    ctx.ui.pushCmd({
      undo: () => {
        const o = ownerOf(id);
        if (o) o.area = cloneArea(before);
        sendArea(id, cloneArea(before));
        refreshAreas();
      },
      redo: () => {
        const o = ownerOf(id);
        if (o) o.area = cloneArea(after);
        sendArea(id, cloneArea(after));
        refreshAreas();
      },
    });
  };
  const startVertDrag = (id: string, idx: number, before: AnnotArea | null): void => {
    const a = ownerOf(id);
    if (!a?.area) return;
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
      if (JSON.stringify(before) !== JSON.stringify(a.area)) pushAreaCmd(a.id, before, cloneArea(a.area));
    };
    map.on("mousemove", onMove);
    document.addEventListener("mouseup", onUp, { once: true, signal: sig });
    refreshAreas();
  };
  map.on("mousedown", "pin-area-verts", (e) => {
    const a = ctx.editAreaId ? ownerOf(ctx.editAreaId) : undefined;
    const idx = e.features?.[0]?.properties?.i as number | undefined;
    if (!a?.area || idx == null || ctx.areaDraft) return;
    e.preventDefault();
    startVertDrag(a.id, idx, cloneArea(a.area));
  });
  map.on("mouseenter", "pin-area-mids-hit", () => {
    if (ctx.editAreaId) map.getCanvas().style.cursor = "copy";
  });
  map.on("mouseleave", "pin-area-mids-hit", () => (map.getCanvas().style.cursor = ctx.ui.modeCursor()));
  map.on("mousedown", "pin-area-mids-hit", (e) => {
    const a = ctx.editAreaId ? ownerOf(ctx.editAreaId) : undefined;
    const seg = e.features?.[0]?.properties?.i as number | undefined;
    if (!a?.area || seg == null || ctx.areaDraft || a.area.pts.length >= AREA_MAX_POINTS) return;
    e.preventDefault();
    const before = cloneArea(a.area);
    const p = a.area.pts[seg];
    const q = a.area.pts[(seg + 1) % a.area.pts.length];
    a.area.pts.splice(seg + 1, 0, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
    startVertDrag(a.id, seg + 1, before);
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
