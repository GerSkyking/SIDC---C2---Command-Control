// Ebenen: Basiskarte-Layer (Sat/Grid/…), Höhenlinien/Höhenpunkte, Enfusion-Vektor-Layer, Orte (Map-Locations)
// mit Sprache, Ebenen-Panel und der Abschnitt „Karte“ im Einstellungs-Menü (Sat-Anpassung, Straßenfarben, Orte-Gruppen).
import type { GeoJSONSource } from "maplibre-gl";
import { api } from "../api";
import {
  addEnfusionLayers,
  ENFUSION_MAPLIBRE_IDS,
  ROAD_COLOR_DEFAULTS,
  setEnfusionOpacity,
  setRoadColors,
  type EnfusionKey,
  type RoadColors,
} from "../enfusionLayers";
import { esc } from "../esc";
import { t } from "../i18n";
import { makeMovable } from "../movable";
import { getMapPrefs, registerSettingsSection, saveMapPrefs } from "../settings";
import type { PlaceInfo, PlanCtx } from "./ctx";

// Tooltips für Basis-Ebenen, deren Name allein wenig sagt (übrige Ebenen erklären sich selbst)
const BASE_TIPS: Record<string, string> = {
  sat: "tip.layers.sat",
  grid: "tip.layers.grid",
  terrain: "tip.layers.terrain",
};

export async function initLayers(ctx: PlanCtx): Promise<void> {
  const { map, root, planId, mapId, baseLayerVisible, strokesLayer } = ctx;
  const { unitAiOpacityExpr } = ctx.model;
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
  // Logische Overlay-Layer -> tatsaechliche MapLibre-Layer-IDs
  const overlayLayers: Record<string, string[]> = {
    contours: ["contours-line", "contours-label"],
    peaks: ["peaks-sym"],
    locations: ["locations-dots", "locations-labels"],
    ...ENFUSION_MAPLIBRE_IDS,
  };
  let enfusionPresent: EnfusionKey[] = [];
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

  // Pro Nutzer (Zahnrad-Menü, am Server gespeichert): Sat-Anpassung, Strassenfarben, ausgeblendete Orte-Gruppen.
  const mapPrefs = getMapPrefs();
  const satAdj = mapPrefs.sat;
  // Server-Default (.env) + nur die vom Nutzer geänderten Farben (localStorage).
  let roadDefaults: RoadColors = { ...ROAD_COLOR_DEFAULTS };
  try {
    roadDefaults = { ...roadDefaults, ...(await api.uiDefaults()).road_colors };
  } catch {
    /* Server ohne Endpunkt -> eingebaute Defaults */
  }
  const roadOverrides = mapPrefs.road as Partial<RoadColors>;
  const roadColors: RoadColors = { ...roadDefaults, ...roadOverrides };

  function applySatAdjust(): void {
    const b = satAdj.brightness / 100;
    for (const id of ["sat", "satsimple"]) {
      if (!map.getLayer(id)) continue;
      map.setPaintProperty(id, "raster-brightness-min", Math.max(0, b));
      map.setPaintProperty(id, "raster-brightness-max", Math.min(1, 1 + b));
      map.setPaintProperty(id, "raster-contrast", satAdj.contrast / 100);
      map.setPaintProperty(id, "raster-saturation", satAdj.saturation / 100);
    }
  }

  function setLayerOpacity(name: string, f: number): void {
    layerOpacity[name] = f;
    try {
      localStorage.setItem("sidc_layeropacity", JSON.stringify(layerOpacity));
    } catch {
      /* ignore */
    }
    const has = (id: string) => !!map.getLayer(id);
    if ((name === "sat" || name === "satsimple" || name === "grid") && has(name)) {
      map.setPaintProperty(name, "raster-opacity", f);
    } else if (name === "contours") {
      if (has("contours-line"))
        map.setPaintProperty("contours-line", "line-opacity", [
          "*",
          f,
          ["case", ["get", "bold"], 0.85, 0.5],
        ]);
      if (has("contours-label")) map.setPaintProperty("contours-label", "text-opacity", f);
    } else if (name in ENFUSION_MAPLIBRE_IDS) {
      setEnfusionOpacity(map, name as EnfusionKey, f);
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
  /** Ort-Chip ({{place:<karte>:<name>}}) dieser Karte: zum Ort fliegen (true), sonst Popover im Chip-Code. */
  ctx.ui.flyToPlace = flyToPlace;
  function flyToPlace(mid: string, name: string): boolean {
    if (mid !== mapId || !locData) return false;
    for (const g of locData.groups)
      for (const it of g.items)
        if (Object.values(it.names).some((n) => n.trim() === name)) {
          map.flyTo({ center: [it.lon, it.lat], zoom: Math.max(map.getZoom(), 12) });
          return true;
        }
    return false;
  }
  // Alle Orte der Karte für die Plan-Suche (auch ausgeblendete Orte-Gruppen), je Ort einmal.
  ctx.ui.listPlaces = (): PlaceInfo[] => {
    const out: PlaceInfo[] = [];
    const seen = new Set<string>();
    for (const g of locData?.groups ?? [])
      for (const it of g.items) {
        const names = [...new Set(Object.values(it.names).map((n) => n.trim()).filter(Boolean))];
        const name = (it.names[mapLang] || it.names.en_us || names[0] || "").trim();
        const key = `${name}|${it.lon.toFixed(5)}|${it.lat.toFixed(5)}`;
        if (!name || seen.has(key)) continue;
        seen.add(key);
        out.push({ name, names, lng: it.lon, lat: it.lat });
      }
    return out;
  };

  map.on("load", async () => {
    // Map-Locations  (Topo/Straßen-Overlay ist derzeit deaktiviert)
    try {
      const r = await fetch(`/api/maps/${mapId}/locations.json`, { credentials: "include" });
      if (r.ok) {
        locData = await r.json();
        mapLang =
          locData!.langs.find((l) => l.startsWith(navigator.language.slice(0, 2))) ??
          (locData!.langs.includes("en_us") ? "en_us" : locData!.langs[0]);
        for (const g of locData!.groups) groupVisible.set(g.key, !mapPrefs.hiddenGroups.includes(g.key));
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
    try {
      await Promise.race([strokesLayer.ready, new Promise((r) => setTimeout(r, 5000))]);
      await addTerrainOverlays();
    } catch (err) {
      console.warn("Terrain-Overlays fehlgeschlagen:", err);
    }
    for (const n of ["sat", "satsimple", "grid", "contours", "peaks", "locations", ...enfusionPresent])
      if (layerOpacity[n] != null) setLayerOpacity(n, layerOpacity[n]);
    applySatAdjust();
    if (enfusionPresent.includes("roads")) setRoadColors(map, roadColors);
    buildLayersPanel();
    buildMapLangSelector();
  });
  const unregisterMapSettings = registerSettingsSection("map", (host) => renderMapSettings(host));
  window.addEventListener("hashchange", unregisterMapSettings, { once: true });

  // Hoehenlinien + dominante Hoehenpunkte (aus dem Mappack, pipeline/terrain_features.py).
  // Standardmaessig aus — Umschalten ueber das Ebenen-Panel.
  async function addTerrainOverlays(): Promise<void> {
    const beforeId = map.getLayer("strokes") ? "strokes" : undefined;
    try {
      enfusionPresent = await addEnfusionLayers(map, (k) => `/api/maps/${mapId}/${k}.geojson`, beforeId);
    } catch (err) {
      console.warn("Enfusion-Layer fehlgeschlagen:", err);
    }
    try {
      const r = await fetch(`/api/maps/${mapId}/contours.geojson`, { credentials: "include" });
      if (r.ok) {
        map.addSource("contours", { type: "geojson", data: await r.json() });
        map.addLayer(
          {
            id: "contours-line",
            type: "line",
            source: "contours",
            layout: { visibility: "visible", "line-join": "round" },
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
              visibility: "visible",
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
              visibility: "visible",
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

  Object.assign(ctx.ui, { belowTopbar, placeNextToTool });
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

  function buildLayersPanel(): void {
    const rows: string[] = [`<div class="fav-head">${t('layers.heading')}</div>`];
    // name -> (Anzeigename, Deckkraft-Regler?)
    const entries: [string, string, boolean][] = [];
    for (const ly of ["sat", "grid", "terrain"])
      if (map.getLayer(ly)) entries.push([ly, t(`layers.${ly}`), ly !== "terrain"]); // Anzeigename übersetzt (vorher Rohname „sat“/„grid“)
    if (hasContours) entries.push(["contours", t("layers.contours"), true]);
    if (hasPeaks) entries.push(["peaks", t("layers.peaks"), true]);
    for (const k of enfusionPresent) entries.push([k, t(`layers.${k}`), true]);
    if (locData) entries.push(["locations", t("layers.places"), true]); // Orte = eigene Ebene

    for (const [name, label, hasSlider] of entries) {
      const on = baseLayerVisible[name] !== false;
      const slider = hasSlider
        ? `<input type="range" min="0" max="100" step="5" value="${Math.round(opac(name) * 100)}" data-op="${esc(name)}" title="${t("layers.opacityHint")}"/>`
        : "";
      rows.push(
        `<div class="layer-row"><label${BASE_TIPS[name] ? ` title="${t(BASE_TIPS[name])}"` : ""}><input type="checkbox" data-base="${esc(name)}" ${on ? "checked" : ""}/> ${label}</label>${slider}</div>`,
      );
    }
    layersPanel.innerHTML = rows.join("");
    layersPanel.querySelectorAll<HTMLInputElement>("[data-base]").forEach((cb) =>
      cb.addEventListener("change", () => {
        const name = cb.dataset.base!;
        baseLayerVisible[name] = cb.checked;
        const targets = overlayLayers[name] ?? [name];
        for (const id of targets)
          if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", cb.checked ? "visible" : "none");
        if (name === "grid") ctx.ui.updateGrid();
      }),
    );
    layersPanel.querySelectorAll<HTMLInputElement>("[data-op]").forEach((sl) =>
      sl.addEventListener("input", () => setLayerOpacity(sl.dataset.op!, +sl.value / 100)),
    );
  }

  // Zahnrad-Menü → Abschnitt "Karte": Sat-Anpassung, Strassenfarben, Orte-Gruppen (pro Nutzer)
  function renderMapSettings(host: HTMLElement): void {
    // Anzeige-Optionen der Marker (früher als Häkchen in der Zeitstrahl-Leiste)
    const disp = document.createElement("div");
    disp.innerHTML =
      `<div class="fav-head">${t("map.display")}</div>` +
      `<div class="layer-row"><label class="chk" title="${t("map.labelsToggle")}"><input type="checkbox" data-lbl ${ctx.showUnitAiLabels ? "checked" : ""}/> ${t("map.labels")}</label></div>` +
      `<div class="layer-row"><label class="chk" title="${t("map.infoToggle")}"><input type="checkbox" data-info ${ctx.showMarkerInfo ? "checked" : ""}/> ${t("map.info")}</label></div>`;
    host.appendChild(disp);
    disp.querySelector<HTMLInputElement>("[data-lbl]")!.addEventListener("change", (e) => {
      ctx.showUnitAiLabels = (e.target as HTMLInputElement).checked;
      try {
        localStorage.setItem("sidc_labels_on", ctx.showUnitAiLabels ? "1" : "0");
      } catch {
        /* ignore */
      }
      map.setPaintProperty("marker-unittext", "text-opacity", unitAiOpacityExpr(ctx.showUnitAiLabels));
      map.setPaintProperty("marker-aitext", "text-opacity", unitAiOpacityExpr(ctx.showUnitAiLabels));
    });
    disp.querySelector<HTMLInputElement>("[data-info]")!.addEventListener("change", (e) => {
      ctx.showMarkerInfo = (e.target as HTMLInputElement).checked;
      try {
        localStorage.setItem("sidc_markerinfo", ctx.showMarkerInfo ? "1" : "0");
      } catch {
        /* ignore */
      }
    });
    const box = document.createElement("div");
    host.appendChild(box);
    const build = () => {
      const rows: string[] = [];
      if (map.getLayer("sat")) {
        const sl = (k: keyof typeof satAdj, label: string) =>
          `<div class="layer-row" title="${t("tip.layers.perUser")}"><label>${label}</label><input type="range" min="-100" max="100" step="5" value="${esc(String(satAdj[k]))}" data-sat="${k}" aria-label="${label}"/></div>`;
        rows.push(
          `<div class="fav-head">${t("layers.satAdjust")}</div>`,
          sl("brightness", t("layers.brightness")),
          sl("contrast", t("layers.contrast")),
          sl("saturation", t("layers.saturation")),
          `<div class="layer-row"><button type="button" data-sat-reset title="${t("tip.layers.satReset")}">${t("layers.reset")}</button></div>`,
        );
      }
      if (enfusionPresent.includes("roads")) {
        const cp = (k: keyof RoadColors, label: string) =>
          `<div class="layer-row" title="${t("tip.layers.perUser")}"><label>${label}</label><input type="color" value="${esc(String(roadColors[k]))}" data-road="${k}" aria-label="${label}"/></div>`;
        rows.push(
          `<div class="fav-head">${t("layers.roadColors")}</div>`,
          cp("main", t("layers.roadMain")),
          cp("secondary", t("layers.roadSecondary")),
          cp("path", t("layers.roadPath")),
          `<div class="layer-row"><button type="button" data-road-reset title="${t("tip.layers.roadReset")}">${t("layers.reset")}</button></div>`,
        );
      }
      if (locData) {
        rows.push(`<div class="fav-head">${t("layers.places")}</div>`);
        for (const g of locData.groups)
          rows.push(
            `<label class="chk" title="${t("tip.layers.placeGroup")}"><input type="checkbox" data-group="${esc(g.key)}" ${groupVisible.get(g.key) !== false ? "checked" : ""}/> ${esc(g.label)} <span class="muted">${g.items.length}</span></label>`,
          );
      }
      box.innerHTML = rows.length ? `<h4>${t("settings.map")}</h4>${rows.join("")}` : "";
      box.querySelectorAll<HTMLInputElement>("[data-sat]").forEach((sl) =>
        sl.addEventListener("input", () => {
          satAdj[sl.dataset.sat as keyof typeof satAdj] = +sl.value;
          saveMapPrefs(mapPrefs);
          applySatAdjust();
        }),
      );
      box.querySelector("[data-sat-reset]")?.addEventListener("click", () => {
        Object.assign(satAdj, { brightness: 0, contrast: 0, saturation: 0 });
        saveMapPrefs(mapPrefs);
        applySatAdjust();
        build();
      });
      box.querySelectorAll<HTMLInputElement>("[data-road]").forEach((inp) =>
        inp.addEventListener("input", () => {
          const k = inp.dataset.road as keyof RoadColors;
          roadColors[k] = inp.value;
          roadOverrides[k] = inp.value;
          saveMapPrefs(mapPrefs);
          setRoadColors(map, roadColors);
        }),
      );
      box.querySelector("[data-road-reset]")?.addEventListener("click", () => {
        Object.assign(roadColors, roadDefaults);
        for (const k of Object.keys(roadOverrides)) delete roadOverrides[k as keyof RoadColors];
        saveMapPrefs(mapPrefs);
        setRoadColors(map, roadColors);
        build();
      });
      box.querySelectorAll<HTMLInputElement>("[data-group]").forEach((cb) =>
        cb.addEventListener("change", () => {
          groupVisible.set(cb.dataset.group!, cb.checked);
          mapPrefs.hiddenGroups = [...groupVisible].filter(([, v]) => v === false).map(([k]) => k);
          saveMapPrefs(mapPrefs);
          refreshLoc();
        }),
      );
    };
    build();
  }

  function buildMapLangSelector(): void {
    const sel = root.querySelector<HTMLSelectElement>("#maplang")!;
    if (!locData) {
      sel.hidden = true;
      return;
    }
    sel.innerHTML = locData.langs.map((l) => `<option value="${esc(l)}" ${l === mapLang ? "selected" : ""}>${esc(l)}</option>`).join("");
    sel.addEventListener("change", () => {
      mapLang = sel.value;
      refreshLoc();
    });
  }

}
