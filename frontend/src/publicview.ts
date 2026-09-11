// Öffentliche Nur-Lese-Ansicht: fast der volle Plan (Karte, Phasen/Zeitstrahl,
// Ebenen, Channel, 2D/3D + Würfel, Screenshot, Präsentation, Dark/Hell, eigener
// Zeiger, lokale Icon-Skalierung) — nur ohne Bearbeiten.
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import { api } from "./api";
import { channelLabel, channelVisibility, type ChannelEntry } from "./sidc/catalog";
import { ensureMapIcon } from "./sidc/symbol";
import { t } from "./i18n";
import { icon } from "./icons";
import { iconBtn, themeSwitch, wireThemeSwitch } from "./ui";
import { makeMovable } from "./movable";
import { renderMarkdown } from "./md";
import { esc } from "./esc";
import { initNavCube } from "./navcube";
import { shotOptsMarkup, wireShotOpts, renderMapCanvas, mimeExt } from "./screenshot";
import { openLightbox } from "./lightbox";
import type { PlanImage as PubImage } from "./api";

interface M {
  id: string;
  world_x: number;
  world_y: number;
  sidc: string;
  unit_text: string;
  ai_text: string;
  icon_rotation: number;
  locked: boolean;
  channel?: string;
  phase_id?: string | null;
  scale?: number;
}
interface S {
  id: string;
  points: [number, number][];
  color: number;
  width: number;
  channel?: string;
  phase_id?: string | null;
}
interface Ph {
  id: string;
  name: string;
  ordering: number;
  plane?: string;
  parent_id?: string | null;
  start_at?: string | null;
  end_at?: string | null;
}
interface An {
  id: string;
  phase_id?: string | null;
  world_x: number;
  world_y: number;
  text: string;
  width: number;
  height?: number;
  scale_fixed?: boolean;
  ref_zoom?: number;
}

function hex(p: number): string {
  return p === undefined || p === -1 ? "#ffd700" : "#" + (p & 0xffffff).toString(16).padStart(6, "0");
}

export async function renderPublicView(root: HTMLElement, token: string): Promise<void> {
  let snap: any;
  try {
    snap = await api.publicSnapshot(token);
  } catch {
    root.innerHTML = `<div class="center"><div class="card"><h1>${t("plan.linkInvalid")}</h1></div></div>`;
    return;
  }

  const markers = new Map<string, M>(snap.markers.map((m: M) => [m.id, m]));
  const strokes = new Map<string, S>(snap.strokes.map((s: S) => [s.id, s]));
  const annots: An[] = snap.annotations ?? [];
  const phases: Ph[] = (snap.phases ?? []).slice().sort((a: Ph, b: Ph) => a.ordering - b.ordering);
  const chanList: ChannelEntry[] | undefined = snap.channels?.channels;

  let currentPhaseId = "";
  let outOpacity = Number(localStorage.getItem("sidc_phaseopacity") ?? "20");
  if (!Number.isFinite(outOpacity)) outOpacity = 20;
  let personalScale = Number(localStorage.getItem("sidc_marker_scale") ?? "1");
  if (!Number.isFinite(personalScale) || personalScale <= 0) personalScale = 1;
  const _chCur = localStorage.getItem(`sidc_pubchan_${token}`) || snap.channels?.currentChannel || "";
  let myChannel = chanList?.find((c) => c.name === _chCur || c.languageKey === _chCur)?.name ?? _chCur;
  let is3D = false;
  const rights: { point: boolean; edit: boolean; move: boolean } = snap.rights ?? {
    point: true,
    edit: false,
    move: false,
  };
  type PMode = "pan" | "point" | "mmove" | "line" | "erase";
  let mode: PMode = "pan";

  const phaseOpacityOf = (pid: string | null | undefined): number => {
    if (pid == null || !currentPhaseId || pid === currentPhaseId) return 1;
    return Math.max(0, Math.min(100, outOpacity)) / 100;
  };
  const opacityOf = (o: { phase_id?: string | null; channel?: string }): number =>
    phaseOpacityOf(o.phase_id) * channelVisibility(chanList, myChannel, o.channel || "");

  root.innerHTML = `
    <div class="topbar">
      <a href="#/" title="${t("nav.back")}">${icon("back")}</a>
      <strong>${esc(snap.plan.name)}</strong>
      <span class="badge">${t("plan.public")}</span>
      <button id="t3d" title="${t("map.threeD")}">3D</button>
      ${iconBtn("north", { id: "compass", cls: "compass", title: t("map.compass") })}
      <span class="shot-wrap">${iconBtn("camera", { id: "shot", title: t("map.screenshot") })}${shotOptsMarkup()}</span>
      ${
        chanList?.length
          ? `<select id="chan" title="${t("map.channel")}">${chanList
              .map((c) => `<option value="${esc(c.name)}" ${c.name === myChannel ? "selected" : ""}>${esc(channelLabel(c))}</option>`)
              .join("")}</select>`
          : ""
      }
      <div id="timeline" class="timeline"></div>
      <span class="grow"></span>
      ${iconBtn("present", { id: "present", title: t("present.start") })}
      ${themeSwitch()}
    </div>
    <div id="map"></div>
    <div id="annots" class="annots"></div>
    <div id="plan-images" class="plan-images"></div>
    <div class="toolbar" id="toolbar">
      ${iconBtn("pan", { id: "tool-pan", active: true, title: t("tool.move") })}
      ${rights.point ? iconBtn("point", { id: "tool-point", title: t("tool.point") }) : ""}
      ${rights.move || rights.edit ? iconBtn("markerMove", { id: "tool-mmove", title: t("tool.markermove") }) : ""}
      ${rights.edit ? iconBtn("line", { id: "tool-line", title: t("tool.line") }) : ""}
      ${rights.edit ? iconBtn("eraser", { id: "tool-erase", title: t("tool.erase") }) : ""}
      <span class="tb-sep"></span>
      ${iconBtn("layers", { id: "layersBtn", title: t("tool.layers") })}
    </div>
    <button class="line-done" id="lineDone" title="${t("line.finish")}" hidden>${icon("check", 18)}</button>
    <div class="mk-scale" id="mkScale" title="${t("marker.scaleLocal")}">
      ${icon("marker", 13)}
      <input type="range" id="mkScaleIn" min="25" max="300" step="5" value="${Math.round(personalScale * 100)}" />
      <span id="mkScaleV">${Math.round(personalScale * 100)}%</span>
    </div>
    <div class="navcube" id="navcube" hidden></div>
    <div class="layers-panel" id="layersPanel" hidden></div>`;

  wireThemeSwitch(root);

  const topbarEl = root.querySelector<HTMLElement>(".topbar")!;
  const syncTopbarH = () => {
    root.style.setProperty("--topbar-h", `${topbarEl.offsetHeight}px`);
    map.resize();
  };

  const map = new maplibregl.Map({
    container: "map",
    style: `/public/plans/${token}/style.json`,
    maxPitch: 0,
    canvasContextAttributes: { preserveDrawingBuffer: true },
    attributionControl: false,
    transformRequest: (url) =>
      url.startsWith("/") || url.startsWith(location.origin) ? { url, credentials: "include" } : { url },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

  syncTopbarH();
  const ro = new ResizeObserver(syncTopbarH);
  ro.observe(topbarEl);
  window.addEventListener("resize", syncTopbarH);

  const applyCameraBounds = () => {
    const src = (map.getStyle()?.sources ?? {}) as Record<string, { bounds?: number[] }>;
    const b = src.sat?.bounds ?? src.grid?.bounds;
    if (!b || b.length !== 4) return;
    const padX = (b[2] - b[0]) * 0.12;
    const padY = (b[3] - b[1]) * 0.12;
    map.setMaxBounds([[b[0] - padX, b[1] - padY], [b[2] + padX, b[3] + padY]]);
    const cam = map.cameraForBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 20 });
    if (cam?.zoom) map.setMinZoom(Math.max(0, cam.zoom - 0.5));
  };
  map.on("load", applyCameraBounds);
  map.on("style.load", applyCameraBounds);

  // ── Marker / Linien ───────────────────────────────────────────────────
  const loaded = new Set<string>();
  const missingIcons = new Set<string>();
  const ensureIcon = async (sidc: string) => {
    if (loaded.has(sidc)) return;
    loaded.add(sidc);
    if (!(await ensureMapIcon(map, sidc))) missingIcons.add(sidc);
  };
  const mFC = (): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: [...markers.values()].map((m) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [m.world_x, m.world_y] },
      properties: {
        id: m.id,
        sidc: m.sidc,
        label: m.unit_text || m.ai_text || "",
        rot: m.icon_rotation || 0,
        dot: missingIcons.has(m.sidc),
        opacity: opacityOf(m),
        scale: Math.max(0.25, Math.min(3, m.scale ?? 1)) * personalScale,
      },
    })),
  });
  const sFC = (): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: [...strokes.values()].map((s) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: s.points },
      properties: {
        id: s.id,
        color: hex(s.color),
        width: s.width > 0 ? s.width : 2,
        opacity: opacityOf(s),
      },
    })),
  });

  // ── Ebenen-Panel ──────────────────────────────────────────────────────
  const baseVisible: Record<string, boolean> = { sat: true, grid: true, contours: true, peaks: true };
  const overlay: Record<string, string[]> = { contours: ["contours-line", "contours-label"], peaks: ["peaks-sym"] };
  let hasContours = false;
  let hasPeaks = false;
  const layersPanel = root.querySelector<HTMLDivElement>("#layersPanel")!;
  const layersBtn = root.querySelector<HTMLButtonElement>("#layersBtn")!;
  const mvLayers = makeMovable(layersPanel, { plan: token, key: "layers", pinnable: true });
  const buildLayers = () => {
    const rows: string[] = [`<div class="fav-head">${t("layers.heading")}</div>`];
    const ents: [string, string][] = [];
    for (const ly of ["sat", "grid"]) if (map.getLayer(ly)) ents.push([ly, ly]);
    if (hasContours) ents.push(["contours", t("layers.contours")]);
    if (hasPeaks) ents.push(["peaks", t("layers.peaks")]);
    for (const [name, label] of ents)
      rows.push(
        `<div class="layer-row"><label><input type="checkbox" data-base="${name}" ${
          baseVisible[name] !== false ? "checked" : ""
        }/> ${label}</label></div>`,
      );
    layersPanel.innerHTML = rows.join("");
    layersPanel.querySelectorAll<HTMLInputElement>("[data-base]").forEach((cb) =>
      cb.addEventListener("change", () => {
        const name = cb.dataset.base!;
        baseVisible[name] = cb.checked;
        for (const id of overlay[name] ?? [name])
          if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", cb.checked ? "visible" : "none");
      }),
    );
  };
  layersBtn.addEventListener("click", () => {
    layersPanel.hidden = !layersPanel.hidden;
    if (!layersPanel.hidden) {
      if (!mvLayers.hasPos())
        layersPanel.style.top = `${(parseInt(getComputedStyle(root).getPropertyValue("--topbar-h")) || 48) + 6}px`;
      buildLayers();
      mvLayers.bringIntoView();
    }
  });

  async function loadExtras(): Promise<void> {
    try {
      const r = await fetch(`/public/plans/${token}/locations.json`, { credentials: "include" });
      if (r.ok) {
        const doc = await r.json();
        let lang = navigator.language.slice(0, 2);
        lang = doc.langs.find((l: string) => l.startsWith(lang)) ?? (doc.langs.includes("en_us") ? "en_us" : doc.langs[0]);
        const fc: GeoJSON.FeatureCollection = {
          type: "FeatureCollection",
          features: doc.groups.flatMap((g: any) =>
            g.items.map((it: any) => ({
              type: "Feature" as const,
              geometry: { type: "Point" as const, coordinates: [it.lon, it.lat] },
              properties: {
                label: it.names[lang] || it.names.en_us || "",
                color: `rgb(${Math.round(it.color[0] * 255)},${Math.round(it.color[1] * 255)},${Math.round(it.color[2] * 255)})`,
                size: 11 + (it.size - 0.75) * 6,
              },
            })),
          ),
        };
        map.addSource("locations", { type: "geojson", data: fc });
        map.addLayer({
          id: "locations-dots",
          type: "circle",
          source: "locations",
          paint: { "circle-radius": 3, "circle-color": ["get", "color"], "circle-stroke-color": "#000", "circle-stroke-width": 1 },
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
            "text-optional": true,
          },
          paint: { "text-color": ["get", "color"], "text-halo-color": "#000", "text-halo-width": 1.6 },
        });
      }
    } catch {
      /* keine Locations */
    }
    for (const [layer, srcName] of [
      ["contours", "contours"],
      ["peaks", "peaks"],
    ] as const) {
      try {
        const r = await fetch(`/public/plans/${token}/${layer}.geojson`, { credentials: "include" });
        if (!r.ok) continue;
        map.addSource(srcName, { type: "geojson", data: await r.json() });
        if (layer === "contours") {
          map.addLayer({
            id: "contours-line",
            type: "line",
            source: "contours",
            layout: { visibility: "visible", "line-join": "round" },
            paint: { "line-color": "#8a6d3b", "line-opacity": ["case", ["get", "bold"], 0.75, 0.45], "line-width": ["case", ["get", "bold"], 1.4, 0.6] },
          });
          map.addLayer({
            id: "contours-label",
            type: "symbol",
            source: "contours",
            filter: ["==", ["get", "bold"], true],
            minzoom: 13,
            layout: { visibility: "visible", "symbol-placement": "line", "text-field": ["concat", ["to-string", ["get", "elev"]], " m"], "text-size": 10 },
            paint: { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 2 },
          });
          hasContours = true;
        } else {
          map.addLayer({
            id: "peaks-sym",
            type: "symbol",
            source: "peaks",
            layout: {
              visibility: "visible",
              "text-field": ["concat", "▲ ", ["to-string", ["get", "elev"]], " m"],
              "text-size": 12,
              "text-anchor": "top",
              "text-offset": [0, 0.4],
              "text-optional": true,
            },
            paint: { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 2 },
          });
          hasPeaks = true;
        }
      } catch {
        /* egal */
      }
    }
  }

  // ── Annotationen (nur Ansicht) ────────────────────────────────────────
  const annotsEl = root.querySelector<HTMLDivElement>("#annots")!;
  let annotRef = 0;
  const annotScale = (a: An): number => {
    if (!a.scale_fixed) return 1;
    const ref = a.ref_zoom && a.ref_zoom > 0 ? a.ref_zoom : annotRef;
    if (!ref) return 1;
    return Math.max(0.3, Math.min(3, 2 ** (map.getZoom() - ref)));
  };
  const wireNoteRefs = (container: HTMLElement) => {
    container.querySelectorAll<HTMLElement>(".note-img-ref").forEach((el) => {
      const id = el.dataset.img ?? "";
      const img = images.find((x) => x.id === id);
      if (img) el.textContent = "🖼︎ " + (img.caption || img.filename);
      el.addEventListener("click", (e) => {
        e.preventDefault();
        openLightbox([{ url: api.publicImageUrl(token, id), caption: img?.caption || img?.filename || "", note: img?.note }]);
      });
    });
  };
  const renderAnnots = () => {
    if (!annotRef) annotRef = map.getZoom();
    annotsEl.innerHTML = annots
      .map(
        (a) =>
          `<div class="annot" data-aid="${a.id}" style="width:${a.width}px;${a.height ? `height:${a.height}px;` : ""}opacity:${phaseOpacityOf(a.phase_id)}">` +
          `<div class="annot-body">${renderMarkdown(a.text || "")}</div></div>`,
      )
      .join("");
    wireNoteRefs(annotsEl);
    positionAnnots();
  };
  const positionAnnots = () => {
    for (const el of Array.from(annotsEl.children) as HTMLElement[]) {
      const a = annots.find((x) => x.id === el.dataset.aid);
      if (!a) continue;
      const p = map.project([a.world_x, a.world_y]);
      el.style.transform = `translate(${p.x}px, ${p.y}px) scale(${annotScale(a)})`;
    }
  };
  map.on("move", positionAnnots);

  // ── Bilder (nur Lesen) ───────────────────────────────────────────────
  const images: PubImage[] = snap.images ?? [];
  const imagesEl = root.querySelector<HTMLDivElement>("#plan-images")!;
  const renderMapImages = () => {
    imagesEl.innerHTML = images
      .filter((i) => i.on_map && phaseOpacityOf(i.phase_id) > 0.001)
      .map(
        (i) =>
          `<div class="pimg" data-iid="${i.id}" style="width:${i.map_width}px;opacity:${phaseOpacityOf(i.phase_id)}">` +
          `<img src="${api.publicImageUrl(token, i.id)}" alt="" draggable="false" /></div>`,
      )
      .join("");
    positionImages();
  };
  const positionImages = () => {
    for (const el of Array.from(imagesEl.children) as HTMLElement[]) {
      const i = images.find((x) => x.id === el.dataset.iid);
      if (!i) continue;
      const p = map.project([i.world_x, i.world_y]);
      el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    }
  };
  imagesEl.addEventListener("dblclick", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".pimg");
    const i = el && images.find((x) => x.id === el.dataset.iid);
    if (i) openLightbox([{ url: api.publicImageUrl(token, i.id), caption: i.caption || i.filename, note: i.note }]);
  });
  map.on("move", positionImages);

  // ── Peers / eigener Zeiger ────────────────────────────────────────────
  const peers = new Map<string, { name: string; lng: number; lat: number; ts: number }>();
  const myUid = "me-" + Math.random().toString(36).slice(2, 8);
  const peerFC = (): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: [...peers.values()]
      .filter((p) => Date.now() - p.ts < 5000)
      .map((p) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.lng, p.lat] },
        properties: { name: p.name },
      })),
  });
  const refreshPeers = () => (map.getSource("peers") as GeoJSONSource)?.setData(peerFC());

  map.on("load", async () => {
    await Promise.all([...new Set([...markers.values()].map((m) => m.sidc))].map(ensureIcon));
    void loadExtras();
    if (map.getSource("terrain-dem")) {
      /* Start in 2D: kein Terrain-Mesh */
    }

    map.addSource("s", { type: "geojson", data: sFC() });
    map.addLayer({
      id: "s",
      type: "line",
      source: "s",
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["get", "width"],
        "line-opacity": ["coalesce", ["get", "opacity"], 1],
      },
      layout: { "line-cap": "round", "line-join": "round" },
    });

    map.addSource("linedraft", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "linedraft",
      type: "line",
      source: "linedraft",
      paint: { "line-color": "#4c8dff", "line-width": 2, "line-dasharray": [2, 1] },
    });

    map.addSource("peers", { type: "geojson", data: peerFC() });
    map.addLayer({
      id: "peers",
      type: "circle",
      source: "peers",
      paint: { "circle-radius": 6, "circle-color": "#ff5bd0", "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
    });
    map.addLayer({
      id: "peers-label",
      type: "symbol",
      source: "peers",
      layout: { "text-field": ["get", "name"], "text-size": 11, "text-offset": [0, 1.2] },
      paint: { "text-color": "#ff9be4", "text-halo-color": "#000", "text-halo-width": 1 },
    });

    map.addSource("m", { type: "geojson", data: mFC() });
    map.addLayer({
      id: "m-dot",
      type: "circle",
      source: "m",
      filter: ["==", ["get", "dot"], true],
      paint: {
        "circle-radius": 5,
        "circle-color": "#4c8dff",
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 1.5,
        "circle-opacity": ["get", "opacity"],
      },
    });
    map.addLayer({
      id: "m",
      type: "symbol",
      source: "m",
      layout: {
        "icon-image": ["get", "sidc"],
        "icon-size": ["*", 0.8, ["coalesce", ["get", "scale"], 1]],
        "icon-rotate": ["get", "rot"],
        "icon-allow-overlap": true,
        "text-field": ["get", "label"],
        "text-optional": true,
        "text-size": 11,
        "text-anchor": "top",
        "text-offset": [0, 1.4],
      },
      paint: {
        "text-color": "#e6e9ee",
        "text-halo-color": "#000",
        "text-halo-width": 1.4,
        "text-opacity": ["get", "opacity"],
        "icon-opacity": ["get", "opacity"],
      },
    });
    renderAnnots();
    renderMapImages();
  });

  const refreshM = async () => {
    await Promise.all([...new Set([...markers.values()].map((m) => m.sidc))].map(ensureIcon));
    (map.getSource("m") as GeoJSONSource)?.setData(mFC());
  };
  const refreshS = () => (map.getSource("s") as GeoJSONSource)?.setData(sFC());
  const refreshAll = () => {
    void refreshM();
    refreshS();
    renderAnnots();
    renderMapImages();
  };

  // ── Channel / Icon-Skalierung ────────────────────────────────────────
  root.querySelector<HTMLSelectElement>("#chan")?.addEventListener("change", (e) => {
    myChannel = (e.target as HTMLSelectElement).value;
    try {
      localStorage.setItem(`sidc_pubchan_${token}`, myChannel);
    } catch {
      /* ignore */
    }
    refreshAll();
  });
  {
    const si = root.querySelector<HTMLInputElement>("#mkScaleIn")!;
    const sv = root.querySelector<HTMLSpanElement>("#mkScaleV")!;
    si.addEventListener("input", () => {
      personalScale = Number(si.value) / 100 || 1;
      sv.textContent = `${si.value}%`;
      try {
        localStorage.setItem("sidc_marker_scale", String(personalScale));
      } catch {
        /* ignore */
      }
      void refreshM();
    });
    makeMovable(root.querySelector<HTMLDivElement>("#mkScale")!, { plan: token, key: "mkscale" });
  }

  // ── Zeitstrahl (nur Ansicht) ─────────────────────────────────────────
  const timelineEl = root.querySelector<HTMLDivElement>("#timeline")!;
  const fmtT = (raw?: string | null) => (raw ? raw.slice(11, 16) : "");
  const renderTimeline = () => {
    if (!phases.length) {
      timelineEl.hidden = true;
      return;
    }
    timelineEl.innerHTML =
      `<span class="ph-label">${t("phase.heading")}:</span>` +
      `<span class="ph-chip ${currentPhaseId === "" ? "active" : ""}"><button data-ph="">${t("phase.global")}</button></span>` +
      phases
        .map((p) => {
          const time = p.start_at ? ` <span class="muted">${fmtT(p.start_at)}${p.end_at ? "–" + fmtT(p.end_at) : ""}</span>` : "";
          return `<span class="ph-chip ${p.id === currentPhaseId ? "active" : ""}${p.plane === "builder" ? " ph-sub" : ""}"><button data-ph="${esc(p.id)}">${p.plane === "builder" ? "⚑ " : ""}${esc(p.name)}${time}</button></span>`;
        })
        .join("") +
      `<label class="ph-op">${t("phase.outOpacity")}<input type="range" id="ph-op" min="0" max="100" step="5" value="${outOpacity}"/><span id="ph-op-v">${outOpacity}%</span></label>`;
    timelineEl.querySelectorAll<HTMLButtonElement>("[data-ph]").forEach((b) =>
      b.addEventListener("click", () => {
        currentPhaseId = b.dataset.ph!;
        renderTimeline();
        refreshAll();
      }),
    );
    const op = timelineEl.querySelector<HTMLInputElement>("#ph-op")!;
    op.addEventListener("input", () => {
      outOpacity = Number(op.value);
      timelineEl.querySelector("#ph-op-v")!.textContent = `${outOpacity}%`;
      localStorage.setItem("sidc_phaseopacity", String(outOpacity));
      refreshAll();
    });
  };
  renderTimeline();

  // ── 2D/3D + Navigations-Würfel ──────────────────────────────────────
  const navcube = root.querySelector<HTMLDivElement>("#navcube")!;
  const nav = initNavCube(map, navcube);
  root.querySelector("#t3d")!.addEventListener("click", () => {
    is3D = !is3D;
    root.querySelector("#t3d")!.classList.toggle("active", is3D);
    nav.setVisible(is3D);
    const hasDem = !!map.getSource("terrain-dem");
    if (is3D) {
      if (hasDem) map.setTerrain({ source: "terrain-dem", exaggeration: 1.5 });
      map.setMaxPitch(85);
      map.easeTo({ pitch: 60, duration: 700 });
    } else {
      map.easeTo({ pitch: 0, duration: 700 });
      map.once("moveend", () => {
        if (!is3D) {
          if (hasDem) map.setTerrain(null);
          map.setMaxPitch(0);
        }
      });
    }
  });

  // ── Kompass ─────────────────────────────────────────────────────────
  const compass = root.querySelector<HTMLButtonElement>("#compass")!;
  const syncCompass = () => compass.style.setProperty("--rot", `${-map.getBearing()}deg`);
  map.on("rotate", syncCompass);
  map.on("load", syncCompass);
  compass.addEventListener("click", () => map.easeTo({ bearing: 0, duration: 400 }));

  // ── Werkzeuge (zeigen / bewegen / Linie / radieren) ────────────────
  const toolbar = root.querySelector<HTMLDivElement>("#toolbar")!;
  const wsSend = (o: unknown) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  const MODE_BTN: Record<PMode, string> = {
    pan: "tool-pan",
    point: "tool-point",
    mmove: "tool-mmove",
    line: "tool-line",
    erase: "tool-erase",
  };
  const setMode = (m: PMode) => {
    mode = m;
    for (const [mm, bid] of Object.entries(MODE_BTN))
      root.querySelector("#" + bid)?.classList.toggle("active", mm === m);
    map.getCanvas().style.cursor = m === "point" || m === "line" ? "crosshair" : m === "erase" ? "not-allowed" : m === "mmove" ? "move" : "";
    if (m === "pan") map.dragPan.enable();
    else map.dragPan.disable();
    if (m !== "line") {
      linePts = [];
      refreshLineDraft();
    }
    if (m !== "point" && ws.readyState === 1) {
      peers.delete(myUid);
      wsSend({ type: "presence.leave" });
      refreshPeers();
    }
  };
  root.querySelector("#tool-pan")!.addEventListener("click", () => setMode("pan"));
  root.querySelector("#tool-point")?.addEventListener("click", () => setMode("point"));
  root.querySelector("#tool-mmove")?.addEventListener("click", () => setMode("mmove"));
  root.querySelector("#tool-line")?.addEventListener("click", () => setMode("line"));
  root.querySelector("#tool-erase")?.addEventListener("click", () => setMode("erase"));
  makeMovable(toolbar, { plan: token, key: "toolbar" });

  let lastSent = 0;
  const sendCursor = (lng: number, lat: number) => {
    if (Date.now() - lastSent < 60 || ws.readyState !== 1) return;
    lastSent = Date.now();
    wsSend({ type: "presence.cursor", lng, lat, user: t("plan.public") });
    peers.set(myUid, { name: "•", lng, lat, ts: Date.now() });
    refreshPeers();
  };

  // Linien zeichnen (nur mit Bearbeiten-Recht)
  const cid = () => Math.random().toString(36).slice(2);
  let linePts: [number, number][] = [];
  const lineDoneBtn = root.querySelector<HTMLButtonElement>("#lineDone")!;
  const refreshLineDraft = () => {
    const src = map.getSource("linedraft") as GeoJSONSource | undefined;
    if (src)
      src.setData({
        type: "FeatureCollection",
        features:
          linePts.length >= 2
            ? [{ type: "Feature", geometry: { type: "LineString", coordinates: linePts }, properties: {} }]
            : [],
      });
    if (mode === "line" && linePts.length >= 2) {
      const p = map.project(linePts[linePts.length - 1]);
      const mr = map.getContainer().getBoundingClientRect();
      const rr = root.getBoundingClientRect();
      lineDoneBtn.hidden = false;
      lineDoneBtn.style.left = `${Math.round(mr.left - rr.left + p.x - 16)}px`;
      lineDoneBtn.style.top = `${Math.round(mr.top - rr.top + p.y - 46)}px`;
    } else lineDoneBtn.hidden = true;
  };
  const finishLine = () => {
    if (linePts.length >= 2)
      wsSend({
        type: "stroke.commit",
        cid: cid(),
        data: { kind: "phaseline", points: linePts, color: -256, width: 2, phase_id: currentPhaseId || null },
      });
    linePts = [];
    refreshLineDraft();
  };
  lineDoneBtn.addEventListener("click", finishLine);
  map.on("move", refreshLineDraft);

  map.on("mousemove", (e) => {
    if (mode === "point") sendCursor(e.lngLat.lng, e.lngLat.lat);
  });
  map.on("click", (e) => {
    if (mode === "line") {
      linePts.push([e.lngLat.lng, e.lngLat.lat]);
      refreshLineDraft();
    }
  });
  map.on("contextmenu", (e) => {
    if (mode === "line" && linePts.length) {
      e.preventDefault();
      linePts = [];
      refreshLineDraft();
    }
  });
  map.on("dblclick", (e) => {
    if (mode === "line") {
      e.preventDefault();
      finishLine();
    }
  });

  // Marker verschieben / radieren
  const onMarkerDown = (e: maplibregl.MapLayerMouseEvent) => {
    if (mode !== "mmove") return;
    const id = e.features?.[0]?.properties?.id as string | undefined;
    const m = id ? markers.get(id) : undefined;
    if (!m || m.locked) return;
    e.preventDefault();
    map.dragPan.disable();
    const onMove = (ev: maplibregl.MapMouseEvent) => {
      m.world_x = ev.lngLat.lng;
      m.world_y = ev.lngLat.lat;
      void refreshM();
    };
    const onUp = (ev: maplibregl.MapMouseEvent) => {
      map.off("mousemove", onMove);
      wsSend({ type: "marker.move", id: m.id, world_x: ev.lngLat.lng, world_y: ev.lngLat.lat });
    };
    map.on("mousemove", onMove);
    map.once("mouseup", onUp);
  };
  const onMarkerClick = (e: maplibregl.MapLayerMouseEvent) => {
    if (mode !== "erase") return;
    const id = e.features?.[0]?.properties?.id as string | undefined;
    if (id && rights.edit) wsSend({ type: "marker.delete", id });
  };
  for (const ly of ["m", "m-dot"]) {
    map.on("mousedown", ly, onMarkerDown);
    map.on("click", ly, onMarkerClick);
  }
  map.on("click", "s", (e) => {
    if (mode === "erase" && rights.edit) {
      const id = e.features?.[0]?.properties?.id as string | undefined;
      if (id) wsSend({ type: "stroke.delete", id });
    }
  });

  // ── Präsentationsmodus ──────────────────────────────────────────────
  let presentBar: HTMLElement | null = null;
  const playerPhases = () => phases.filter((p) => (p.plane ?? "player") !== "builder");
  const stepPresent = (dir: number) => {
    const list = playerPhases();
    if (!list.length) return;
    let i = list.findIndex((p) => p.id === currentPhaseId);
    if (i < 0) i = 0;
    const nxt = list[(i + dir + list.length) % list.length];
    currentPhaseId = nxt.id;
    renderTimeline();
    refreshAll();
    updatePb();
  };
  const updatePb = () => {
    if (!presentBar) return;
    const list = playerPhases();
    const idx = list.findIndex((p) => p.id === currentPhaseId);
    presentBar.querySelector(".pb-name")!.textContent = `${list[idx]?.name ?? "—"}  (${idx + 1}/${list.length || 1})`;
  };
  const onPresentKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") exitPresent();
    else if (e.key === "ArrowRight" || e.key === "PageDown") stepPresent(1);
    else if (e.key === "ArrowLeft" || e.key === "PageUp") stepPresent(-1);
  };
  const exitPresent = () => {
    root.classList.remove("presenting");
    presentBar?.remove();
    presentBar = null;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    document.removeEventListener("keydown", onPresentKey);
    map.resize();
  };
  root.querySelector("#present")!.addEventListener("click", () => {
    root.classList.add("presenting");
    presentBar = document.createElement("div");
    presentBar.className = "present-bar";
    presentBar.innerHTML =
      `<button class="icon-btn" data-pb="prev">${icon("back")}</button>` +
      `<span class="pb-name"></span>` +
      `<button class="icon-btn" data-pb="next">${icon("chevron")}</button>` +
      `<button class="icon-btn" data-pb="exit" title="${t("present.exit")}">${icon("x")}</button>`;
    root.appendChild(presentBar);
    presentBar.querySelector('[data-pb="prev"]')!.addEventListener("click", () => stepPresent(-1));
    presentBar.querySelector('[data-pb="next"]')!.addEventListener("click", () => stepPresent(1));
    presentBar.querySelector('[data-pb="exit"]')!.addEventListener("click", exitPresent);
    document.addEventListener("keydown", onPresentKey);
    document.documentElement.requestFullscreen?.().catch(() => {});
    updatePb();
    setTimeout(() => map.resize(), 60);
  });

  // ── Screenshot ──────────────────────────────────────────────────────
  const shotBtn = root.querySelector<HTMLButtonElement>("#shot")!;
  const getShotOpts = wireShotOpts(root);
  shotBtn.addEventListener("click", async () => {
    shotBtn.disabled = true;
    try {
      const { res, fmt } = getShotOpts();
      const out = await renderMapCanvas(map, res);
      const { mime, ext, quality } = mimeExt(fmt);
      const a = document.createElement("a");
      a.href = out.toDataURL(mime, quality);
      const safe = (s: string) => s.replace(/[^\w.-]+/g, "_") || "map";
      a.download = `${safe(snap.plan.name)}_${Date.now()}.${ext}`;
      a.click();
    } finally {
      shotBtn.disabled = false;
    }
  });

  // ── Live-WebSocket ──────────────────────────────────────────────────
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/public/plans/${token}/live`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case "marker.upsert":
        markers.set(msg.marker.id, msg.marker);
        void refreshM();
        break;
      case "marker.delete":
        markers.delete(msg.id);
        void refreshM();
        break;
      case "stroke.upsert":
        strokes.set(msg.stroke.id, msg.stroke);
        refreshS();
        break;
      case "stroke.delete":
        strokes.delete(msg.id);
        refreshS();
        break;
      case "annotation.upsert": {
        const i = annots.findIndex((a) => a.id === msg.annotation.id);
        if (i >= 0) annots[i] = msg.annotation;
        else annots.push(msg.annotation);
        renderAnnots();
        break;
      }
      case "annotation.delete": {
        const i = annots.findIndex((a) => a.id === msg.id);
        if (i >= 0) annots.splice(i, 1);
        renderAnnots();
        break;
      }
      case "image.upsert": {
        const i = images.findIndex((x) => x.id === msg.image.id);
        if (i >= 0) images[i] = msg.image;
        else images.push(msg.image);
        renderMapImages();
        break;
      }
      case "image.delete": {
        const i = images.findIndex((x) => x.id === msg.id);
        if (i >= 0) images.splice(i, 1);
        renderMapImages();
        break;
      }
      case "presence.cursor":
        if (msg.uid !== myUid)
          peers.set(msg.uid, { name: msg.user || "•", lng: msg.lng, lat: msg.lat, ts: Date.now() });
        refreshPeers();
        break;
      case "presence.leave":
        peers.delete(msg.uid);
        refreshPeers();
        break;
    }
  };
  const peerTimer = window.setInterval(refreshPeers, 2000);
  window.addEventListener(
    "hashchange",
    () => {
      ws.close();
      ro.disconnect();
      window.clearInterval(peerTimer);
      window.removeEventListener("resize", syncTopbarH);
      root.style.removeProperty("--topbar-h");
    },
    { once: true },
  );
}
