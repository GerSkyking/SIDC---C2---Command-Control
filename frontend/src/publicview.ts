// Öffentliche Nur-Lese-Ansicht: fast der volle Plan (Karte, Phasen/Zeitstrahl,
// Ebenen, Channel, 2D/3D + Würfel, Screenshot, Präsentation, Dark/Hell, eigener
// Zeiger, lokale Icon-Skalierung) — nur ohne Bearbeiten.
import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import { api } from "./api";
import { channelLabel, channelVisibility, type ChannelEntry } from "./sidc/catalog";
import { ensureMapIcon } from "./sidc/symbol";
import { t } from "./i18n";
import { icon } from "./icons";
import { iconBtn, themeSwitch, wireThemeSwitch } from "./ui";
import { makeMovable } from "./movable";
import { renderMarkdown } from "./md";

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
  let pointMode = false;

  const phaseOpacityOf = (pid: string | null | undefined): number => {
    if (pid == null || !currentPhaseId || pid === currentPhaseId) return 1;
    return Math.max(0, Math.min(100, outOpacity)) / 100;
  };
  const opacityOf = (o: { phase_id?: string | null; channel?: string }): number =>
    phaseOpacityOf(o.phase_id) * channelVisibility(chanList, myChannel, o.channel || "");

  root.innerHTML = `
    <div class="topbar">
      <a href="#/" title="${t("nav.back")}">${icon("back")}</a>
      <strong>${snap.plan.name}</strong>
      <span class="badge">${t("plan.public")}</span>
      <button id="t3d" title="${t("map.threeD")}">3D</button>
      ${iconBtn("north", { id: "compass", cls: "compass", title: t("map.compass") })}
      ${iconBtn("camera", { id: "shot", title: t("map.screenshot") })}
      ${
        chanList?.length
          ? `<select id="chan" title="${t("map.channel")}">${chanList
              .map((c) => `<option value="${c.name}" ${c.name === myChannel ? "selected" : ""}>${channelLabel(c)}</option>`)
              .join("")}</select>`
          : ""
      }
      <div id="timeline" class="timeline"></div>
      ${iconBtn("layers", { id: "layersBtn", title: t("tool.layers") })}
      <span class="grow"></span>
      ${iconBtn("present", { id: "present", title: t("present.start") })}
      ${themeSwitch()}
    </div>
    <div id="map"></div>
    <div id="annots" class="annots"></div>
    <div class="toolbar" id="toolbar">
      ${iconBtn("pan", { id: "tool-pan", active: true, title: t("tool.move") })}
      ${iconBtn("point", { id: "tool-point", title: t("tool.point") })}
    </div>
    <div class="mk-scale" id="mkScale" title="${t("marker.scaleLocal")}">
      ${icon("marker", 13)}
      <input type="range" id="mkScaleIn" min="25" max="300" step="5" value="${Math.round(personalScale * 100)}" />
      <span id="mkScaleV">${Math.round(personalScale * 100)}%</span>
    </div>
    <div class="navcube" id="navcube" title="${t("map.navcube")}" hidden>
      <div class="ncube">
        <button class="ncf ncf-top" data-face="top">▲</button>
        <button class="ncf ncf-n" data-face="n">N</button>
        <button class="ncf ncf-s" data-face="s">S</button>
        <button class="ncf ncf-e" data-face="e">O</button>
        <button class="ncf ncf-w" data-face="w">W</button>
      </div>
    </div>
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
        color: hex(s.color),
        width: s.width > 0 ? s.width : 2,
        opacity: opacityOf(s),
      },
    })),
  });

  // ── Ebenen-Panel ──────────────────────────────────────────────────────
  const baseVisible: Record<string, boolean> = { sat: true, grid: true, contours: false, peaks: false };
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
            layout: { visibility: "none", "line-join": "round" },
            paint: { "line-color": "#8a6d3b", "line-opacity": ["case", ["get", "bold"], 0.75, 0.45], "line-width": ["case", ["get", "bold"], 1.4, 0.6] },
          });
          map.addLayer({
            id: "contours-label",
            type: "symbol",
            source: "contours",
            filter: ["==", ["get", "bold"], true],
            minzoom: 13,
            layout: { visibility: "none", "symbol-placement": "line", "text-field": ["concat", ["to-string", ["get", "elev"]], " m"], "text-size": 10 },
            paint: { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 2 },
          });
          hasContours = true;
        } else {
          map.addLayer({
            id: "peaks-sym",
            type: "symbol",
            source: "peaks",
            layout: {
              visibility: "none",
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
  const renderAnnots = () => {
    if (!annotRef) annotRef = map.getZoom();
    annotsEl.innerHTML = annots
      .map(
        (a) =>
          `<div class="annot" data-aid="${a.id}" style="width:${a.width}px;${a.height ? `height:${a.height}px;` : ""}opacity:${phaseOpacityOf(a.phase_id)}">` +
          `<div class="annot-body">${renderMarkdown(a.text || "")}</div></div>`,
      )
      .join("");
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
          return `<span class="ph-chip ${p.id === currentPhaseId ? "active" : ""}${p.plane === "builder" ? " ph-sub" : ""}"><button data-ph="${p.id}">${p.plane === "builder" ? "⚑ " : ""}${p.name}${time}</button></span>`;
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

  // ── 2D/3D + Würfel ──────────────────────────────────────────────────
  const navcube = root.querySelector<HTMLDivElement>("#navcube")!;
  const ncube = navcube.querySelector<HTMLDivElement>(".ncube")!;
  const syncCube = () => {
    ncube.style.transform = `rotateX(${map.getPitch() - 90}deg) rotateZ(${map.getBearing()}deg)`;
  };
  map.on("rotate", syncCube);
  map.on("pitch", syncCube);
  map.on("load", syncCube);
  root.querySelector("#t3d")!.addEventListener("click", () => {
    is3D = !is3D;
    root.querySelector("#t3d")!.classList.toggle("active", is3D);
    navcube.hidden = !is3D;
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
  const FACE_BEARING: Record<string, number> = { n: 0, e: 90, s: 180, w: 270 };
  let cubeDragged = false;
  navcube.querySelectorAll<HTMLButtonElement>("[data-face]").forEach((b) =>
    b.addEventListener("click", () => {
      if (cubeDragged) {
        cubeDragged = false;
        return;
      }
      const f = b.dataset.face!;
      if (f === "top") map.easeTo({ pitch: 0, duration: 500 });
      else map.easeTo({ bearing: FACE_BEARING[f], pitch: 45, duration: 500 });
    }),
  );
  navcube.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const sb = map.getBearing();
    const sp = map.getPitch();
    cubeDragged = false;
    navcube.classList.add("drag");
    const mv = (ev: MouseEvent) => {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3) cubeDragged = true;
      map.setBearing(sb + (ev.clientX - sx) * 0.6);
      map.setPitch(Math.max(0, Math.min(85, sp - (ev.clientY - sy) * 0.4)));
    };
    const up = () => {
      document.removeEventListener("mousemove", mv);
      document.removeEventListener("mouseup", up);
      navcube.classList.remove("drag");
    };
    document.addEventListener("mousemove", mv);
    document.addEventListener("mouseup", up);
  });

  // ── Kompass ─────────────────────────────────────────────────────────
  const compass = root.querySelector<HTMLButtonElement>("#compass")!;
  const syncCompass = () => compass.style.setProperty("--rot", `${-map.getBearing()}deg`);
  map.on("rotate", syncCompass);
  map.on("load", syncCompass);
  compass.addEventListener("click", () => map.easeTo({ bearing: 0, duration: 400 }));

  // ── Werkzeug: zeigen ────────────────────────────────────────────────
  const panBtn = root.querySelector<HTMLButtonElement>("#tool-pan")!;
  const pointBtn = root.querySelector<HTMLButtonElement>("#tool-point")!;
  const setPoint = (on: boolean) => {
    pointMode = on;
    panBtn.classList.toggle("active", !on);
    pointBtn.classList.toggle("active", on);
    map.getCanvas().style.cursor = on ? "crosshair" : "";
    if (on) map.dragPan.disable();
    else {
      map.dragPan.enable();
      peers.delete(myUid);
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "presence.leave" }));
    }
    refreshPeers();
  };
  panBtn.addEventListener("click", () => setPoint(false));
  pointBtn.addEventListener("click", () => setPoint(true));
  makeMovable(root.querySelector<HTMLDivElement>("#toolbar")!, { plan: token, key: "toolbar" });

  let lastSent = 0;
  const sendCursor = (lng: number, lat: number) => {
    if (Date.now() - lastSent < 60 || ws.readyState !== 1) return;
    lastSent = Date.now();
    ws.send(JSON.stringify({ type: "presence.cursor", lng, lat, user: t("plan.public") }));
    peers.set(myUid, { name: "•", lng, lat, ts: Date.now() });
    refreshPeers();
  };
  map.on("mousemove", (e) => {
    if (pointMode) sendCursor(e.lngLat.lng, e.lngLat.lat);
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
  shotBtn.addEventListener("click", async () => {
    shotBtn.disabled = true;
    try {
      await new Promise<void>((res) => {
        if (map.loaded() && !map.isMoving()) return res();
        map.once("idle", () => res());
        map.triggerRepaint();
      });
      map.redraw();
      const mc = map.getCanvas();
      const a = document.createElement("a");
      a.href = mc.toDataURL("image/png");
      const safe = (s: string) => s.replace(/[^\w.-]+/g, "_") || "map";
      a.download = `${safe(snap.plan.name)}_${Date.now()}.png`;
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
