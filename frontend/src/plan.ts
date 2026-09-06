// Plan-Ansicht: Karte + Werkzeugleiste + HUD + Marker/Zeichnen/Präsenz live.
// Nähert sich der ATAKmaps-UI an (D:\Mods\ATAKmaps).
import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import { api, type Me } from "./api";
import { channelLabel, loadChannels } from "./sidc/catalog";
import { iconUrl, lngLatToWorld, type Calibration } from "./sidc/sidc";
import { openWizard, type MarkerTemplate } from "./sidc/wizard";
import { cid, PlanSocket, type WsMessage } from "./ws";

interface Marker {
  id: string;
  world_x: number;
  world_y: number;
  sidc: string;
  unit_text: string;
  ai_text: string;
  channel: string;
  locked: boolean;
  rotation_degrees: number;
  icon_rotation: number;
  phase_id: string | null;
  layer_id: string | null;
}
interface Stroke {
  id: string;
  points: [number, number][];
  color: number;
  width: number;
}
type Mode = "move" | "point" | "draw" | "place";

export async function openPlanView(root: HTMLElement, planId: string, me: Me): Promise<void> {
  const snap = await api.snapshot(planId);
  const mapId: string = snap.plan.map_id;
  const cal: Calibration | null = snap.map_meta?.calibration ?? null;
  const markers = new Map<string, Marker>(snap.markers.map((m: Marker) => [m.id, m]));
  const strokes = new Map<string, Stroke>(snap.strokes.map((s: Stroke) => [s.id, s]));
  const myPlan = (await api.plans()).find((p) => p.id === planId);
  const canEdit = myPlan?.level === "editor" || myPlan?.level === "owner";
  const channels = await loadChannels();

  const peers = new Map<string, { name: string; lng: number; lat: number; t: number }>();
  let mode: Mode = "move";
  let pending: MarkerTemplate | null = null;
  let myChannel = channels?.currentChannel ?? "";
  let is3D = false;

  root.innerHTML = `
    <div class="topbar">
      <a href="#/">←</a>
      <strong>${snap.plan.name}</strong>
      <span class="badge">${myPlan?.level ?? "?"}</span>
      <button id="t3d">3D</button>
      <select id="chan" title="Mein Channel">${(channels?.channels ?? [])
        .map((c) => `<option value="${c.name}" ${c.name === myChannel ? "selected" : ""}>${channelLabel(c)}</option>`)
        .join("")}</select>
      <div id="timeline" class="timeline"></div>
      <span class="grow"></span>
      <span class="presence" id="presence"></span>
      ${canEdit ? `<button id="save">Version</button>` : ""}
    </div>
    <div id="map"></div>
    ${
      canEdit
        ? `<div class="toolbar" id="toolbar">
             <button data-mode="move" class="active" title="Karte bewegen">✋</button>
             <button data-mode="point" title="Zeigen (Cursor für andere)">👉</button>
             <button data-mode="draw" title="Malen">✏️</button>
             <button id="tool-marker" title="Marker setzen">📍</button>
             <button id="tool-fav" title="Favoriten">★</button>
           </div>
           <div class="fav-panel" id="favPanel" hidden></div>`
        : ""
    }
    <div class="hud" id="hud">X: – &nbsp; Y: – &nbsp; H: –</div>`;

  const map = new maplibregl.Map({
    container: "map",
    style: `/api/maps/${mapId}/style.json`,
    transformRequest: (url) =>
      url.startsWith("/") || url.startsWith(location.origin) ? { url, credentials: "include" } : { url },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

  const loadedIcons = new Set<string>();
  async function ensureIcon(sidc: string): Promise<void> {
    if (loadedIcons.has(sidc) || map.hasImage(sidc)) return;
    loadedIcons.add(sidc);
    try {
      const img = await map.loadImage(iconUrl(sidc));
      if (!map.hasImage(sidc)) map.addImage(sidc, img.data);
    } catch {
      /* fehlendes Icon: Symbol-Layer zeigt dann nichts */
    }
  }

  const markerFC = (): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: [...markers.values()].map((m) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [m.world_x, m.world_y] },
      properties: {
        id: m.id,
        sidc: m.sidc,
        label: m.unit_text || m.ai_text || "",
        rot: m.icon_rotation || 0,
        locked: m.locked,
      },
    })),
  });
  const strokeFC = (): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: [...strokes.values()].map((s) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: s.points },
      properties: { color: packedToHex(s.color), width: s.width > 0 ? s.width : 2 },
    })),
  });
  const peerFC = (): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: [...peers.values()]
      .filter((p) => Date.now() - p.t < 5000)
      .map((p) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.lng, p.lat] },
        properties: { name: p.name },
      })),
  });

  map.on("load", async () => {
    await Promise.all([...new Set([...markers.values()].map((m) => m.sidc))].map(ensureIcon));

    map.addSource("strokes", { type: "geojson", data: strokeFC() });
    map.addLayer({
      id: "strokes",
      type: "line",
      source: "strokes",
      paint: { "line-color": ["get", "color"], "line-width": ["get", "width"] },
      layout: { "line-cap": "round", "line-join": "round" },
    });

    map.addSource("markers", { type: "geojson", data: markerFC() });
    map.addLayer({
      id: "marker-icon",
      type: "symbol",
      source: "markers",
      layout: {
        "icon-image": ["get", "sidc"],
        "icon-size": 0.8,
        "icon-rotate": ["get", "rot"],
        "icon-allow-overlap": true,
        "text-field": ["get", "label"],
        "text-optional": true,
        "text-size": 11,
        "text-offset": [0, 1.6],
        "text-allow-overlap": false,
      },
      paint: {
        "text-color": "#e6e9ee",
        "text-halo-color": "#000",
        "text-halo-width": 1.4,
        "icon-opacity": ["case", ["get", "locked"], 0.6, 1],
      },
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
  });

  const refreshMarkers = async () => {
    await Promise.all([...new Set([...markers.values()].map((m) => m.sidc))].map(ensureIcon));
    (map.getSource("markers") as GeoJSONSource)?.setData(markerFC());
  };
  const refreshStrokes = () => (map.getSource("strokes") as GeoJSONSource)?.setData(strokeFC());
  const refreshPeers = () => (map.getSource("peers") as GeoJSONSource)?.setData(peerFC());

  // ── WebSocket ──────────────────────────────────────────────────────────
  const socket = new PlanSocket(planId);
  const presenceEl = root.querySelector<HTMLSpanElement>("#presence")!;
  const names = new Map<string, string>();
  const renderPresence = () =>
    (presenceEl.innerHTML = [...names.values()].map((n) => `<span class="badge">${n}</span>`).join(""));

  socket.on((msg: WsMessage) => {
    switch (msg.type) {
      case "presence.join":
        if (msg.uid !== me.id) names.set(msg.uid, msg.user);
        renderPresence();
        break;
      case "presence.leave":
        names.delete(msg.uid);
        peers.delete(msg.uid);
        renderPresence();
        refreshPeers();
        break;
      case "presence.cursor":
        if (msg.uid !== me.id) {
          peers.set(msg.uid, { name: names.get(msg.uid) ?? "?", lng: msg.lng, lat: msg.lat, t: Date.now() });
          refreshPeers();
        }
        break;
      case "marker.upsert":
        markers.set(msg.marker.id, msg.marker);
        void refreshMarkers();
        break;
      case "marker.delete":
        markers.delete(msg.id);
        void refreshMarkers();
        break;
      case "stroke.upsert":
        strokes.set(msg.stroke.id, msg.stroke);
        refreshStrokes();
        break;
      case "stroke.delete":
        strokes.delete(msg.id);
        refreshStrokes();
        break;
    }
  });
  socket.connect();
  window.addEventListener("hashchange", () => socket.close(), { once: true });

  // ── HUD (Cursor X/Y/Höhe) ──────────────────────────────────────────────
  const hud = root.querySelector<HTMLDivElement>("#hud")!;
  let lastCursorSent = 0;
  map.on("mousemove", (e) => {
    const [wx, wy] = lngLatToWorld(cal, e.lngLat.lng, e.lngLat.lat);
    let h = "–";
    try {
      const el = map.queryTerrainElevation(e.lngLat);
      if (el != null) h = `${el.toFixed(0)} m`;
    } catch {
      /* kein Terrain */
    }
    hud.textContent = `X: ${wx.toFixed(0)}  Y: ${wy.toFixed(0)}  H: ${h}`;
    if (mode === "point" && Date.now() - lastCursorSent > 60) {
      lastCursorSent = Date.now();
      socket.send({ type: "presence.cursor", lng: e.lngLat.lng, lat: e.lngLat.lat });
    }
  });

  // ── 2D/3D ─────────────────────────────────────────────────────────────
  root.querySelector("#t3d")!.addEventListener("click", () => {
    is3D = !is3D;
    root.querySelector("#t3d")!.classList.toggle("active", is3D);
    if (is3D && map.getSource("terrain-dem")) {
      map.setTerrain({ source: "terrain-dem", exaggeration: 1.5 });
      map.easeTo({ pitch: 60, duration: 700 });
    } else {
      map.setTerrain(null);
      map.easeTo({ pitch: 0, bearing: 0, duration: 700 });
    }
  });

  // ── Channel ───────────────────────────────────────────────────────────
  root.querySelector<HTMLSelectElement>("#chan")!.addEventListener("change", (e) => {
    myChannel = (e.target as HTMLSelectElement).value;
  });

  if (!canEdit) return;

  // ── Werkzeugleiste ────────────────────────────────────────────────────
  const toolbar = root.querySelector<HTMLDivElement>("#toolbar")!;
  const setMode = (m: Mode) => {
    mode = m;
    toolbar.querySelectorAll("[data-mode]").forEach((b) =>
      b.classList.toggle("active", (b as HTMLElement).dataset.mode === m),
    );
    map.getCanvas().style.cursor = m === "place" ? "crosshair" : m === "draw" ? "cell" : "";
    if (m === "draw") map.dragPan.disable();
    else map.dragPan.enable();
  };
  toolbar.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      pending = null;
      setMode(b.dataset.mode as Mode);
    }),
  );
  root.querySelector("#tool-marker")!.addEventListener("click", () => {
    openWizard(root, (tpl) => {
      pending = tpl;
      setMode("place");
    });
  });

  // ── Favoriten ─────────────────────────────────────────────────────────
  const favPanel = root.querySelector<HTMLDivElement>("#favPanel")!;
  let favs = await api.favorites();
  const renderFavs = () => {
    favPanel.innerHTML =
      `<div class="fav-head">Favoriten</div>` +
      (favs.length
        ? favs
            .map(
              (f) => `<div class="fav" data-fav="${f.id}">
                <img src="${iconUrl(f.sidc)}" width="24" height="24" onerror="this.style.visibility='hidden'"/>
                <span>${f.label}</span><button data-delfav="${f.id}">✕</button></div>`,
            )
            .join("")
        : `<div class="muted">Marker anklicken → „Favorit"</div>`);
    favPanel.querySelectorAll<HTMLElement>("[data-fav]").forEach((el) =>
      el.addEventListener("click", (ev) => {
        if ((ev.target as HTMLElement).dataset.delfav) return;
        const f = favs.find((x) => x.id === el.dataset.fav)!;
        pending = {
          sidc: f.sidc,
          unit_text: f.unit_text,
          ai_text: f.ai_text,
          channel: myChannel,
          locked: false,
          timestamp_visible: true,
          rotation_degrees: f.rotation_degrees,
          is_multipoint: false,
          max_line_points: 0,
        };
        setMode("place");
      }),
    );
    favPanel.querySelectorAll<HTMLButtonElement>("[data-delfav]").forEach((b) =>
      b.addEventListener("click", async () => {
        await api.deleteFavorite(b.dataset.delfav!);
        favs = await api.favorites();
        renderFavs();
      }),
    );
  };
  renderFavs();
  root.querySelector("#tool-fav")!.addEventListener("click", () => (favPanel.hidden = !favPanel.hidden));

  // ── Karten-Interaktion ────────────────────────────────────────────────
  map.on("click", "marker-icon", (e) => {
    e.preventDefault();
    const id = e.features?.[0]?.properties?.id as string;
    const m = markers.get(id);
    if (m) openEditPanel(m);
  });

  map.on("click", (e) => {
    if ((e as any).defaultPrevented) return;
    if (mode === "place" && pending) {
      const [wx, wy] = [e.lngLat.lng, e.lngLat.lat];
      socket.send({
        type: "marker.create",
        cid: cid(),
        data: {
          sidc: pending.sidc,
          world_x: wx,
          world_y: wy,
          unit_text: pending.unit_text,
          ai_text: pending.ai_text,
          channel: pending.channel || myChannel,
          locked: pending.locked,
          timestamp_visible: pending.timestamp_visible,
          rotation_degrees: pending.rotation_degrees,
        },
      });
      if (!pending.is_multipoint) {
        pending = null;
        setMode("move");
      }
    }
  });

  // Freihand-Zeichnen
  let drawing: [number, number][] | null = null;
  map.on("mousedown", (e) => {
    if (mode !== "draw") return;
    drawing = [[e.lngLat.lng, e.lngLat.lat]];
  });
  map.on("mousemove", (e) => {
    if (mode !== "draw" || !drawing) return;
    drawing.push([e.lngLat.lng, e.lngLat.lat]);
  });
  map.on("mouseup", () => {
    if (mode !== "draw" || !drawing) return;
    if (drawing.length > 1) {
      socket.send({ type: "stroke.commit", cid: cid(), data: { kind: "freehand", points: drawing, width: 2 } });
    }
    drawing = null;
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      pending = null;
      setMode("move");
    }
  });

  // ── Marker-Edit-Panel ─────────────────────────────────────────────────
  function openEditPanel(m: Marker): void {
    root.querySelector("#editPanel")?.remove();
    const p = document.createElement("div");
    p.className = "edit-panel";
    p.id = "editPanel";
    p.innerHTML = `
      <div class="fav-head"><img src="${iconUrl(m.sidc)}" width="26" height="26" onerror="this.style.visibility='hidden'"/> Marker</div>
      <label>Einheitstext</label><input data-unit value="${m.unit_text}" />
      <label>Zusatztext</label><input data-ai value="${m.ai_text}" />
      <label>Icon-Drehung (°)</label><input data-rot type="number" value="${m.icon_rotation || 0}" />
      <label><input type="checkbox" data-lock ${m.locked ? "checked" : ""}/> Gesperrt</label>
      <div class="row">
        <button class="primary" data-apply>Übernehmen</button>
        <button data-fav>★ Favorit</button>
        <button data-clone>Klonen</button>
        <button data-del>Löschen</button>
      </div>`;
    root.appendChild(p);
    p.querySelector("[data-apply]")!.addEventListener("click", () => {
      socket.send({
        type: "marker.modify",
        id: m.id,
        data: {
          unit_text: p.querySelector<HTMLInputElement>("[data-unit]")!.value,
          ai_text: p.querySelector<HTMLInputElement>("[data-ai]")!.value,
          icon_rotation: Number(p.querySelector<HTMLInputElement>("[data-rot]")!.value) || 0,
        },
      });
      socket.send({ type: "marker.lock", id: m.id, locked: p.querySelector<HTMLInputElement>("[data-lock]")!.checked });
      p.remove();
    });
    p.querySelector("[data-del]")!.addEventListener("click", () => {
      socket.send({ type: "marker.delete", id: m.id });
      p.remove();
    });
    p.querySelector("[data-clone]")!.addEventListener("click", () => {
      pending = {
        sidc: m.sidc,
        unit_text: m.unit_text,
        ai_text: m.ai_text,
        channel: m.channel,
        locked: m.locked,
        timestamp_visible: true,
        rotation_degrees: m.rotation_degrees,
        is_multipoint: false,
        max_line_points: 0,
      };
      setMode("place");
      p.remove();
    });
    p.querySelector("[data-fav]")!.addEventListener("click", async () => {
      const label = prompt("Bezeichnung für den Favoriten:", m.unit_text || m.sidc.slice(0, 8));
      if (!label) return;
      await api.addFavorite({
        label,
        sidc: m.sidc,
        rotation_degrees: m.rotation_degrees,
        unit_text: m.unit_text,
        ai_text: m.ai_text,
      });
      favs = await api.favorites();
      renderFavs();
      favPanel.hidden = false;
    });
  }

  root.querySelector("#save")?.addEventListener("click", async () => {
    await api.saveVersion(planId, prompt("Bezeichnung der Version:") ?? "");
    alert("Version gespeichert");
  });
}

function packedToHex(packed: number): string {
  if (packed === undefined || packed === -1 || Number.isNaN(packed)) return "#ffd700";
  const n = packed & 0xffffff;
  return "#" + n.toString(16).padStart(6, "0");
}
