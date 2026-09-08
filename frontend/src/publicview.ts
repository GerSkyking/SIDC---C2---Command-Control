// Öffentliche Nur-Lese-Ansicht eines Plans (kein Login) — Karte + Marker + Zeichnungen,
// Live-Updates über den Empfangs-WebSocket. Keine Werkzeuge.
import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import { api } from "./api";
import { ensureMapIcon } from "./sidc/symbol";
import { t } from "./i18n";
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
}
interface S {
  id: string;
  points: [number, number][];
  color: number;
  width: number;
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

  const annotations: {
    id: string;
    world_x: number;
    world_y: number;
    text: string;
    width: number;
  }[] = snap.annotations ?? [];

  root.innerHTML = `
    <div class="topbar"><strong>${snap.plan.name}</strong><span class="badge">${t("plan.public")}</span></div>
    <div id="map"></div>
    <div id="annots" class="annots"></div>`;

  const map = new maplibregl.Map({
    container: "map",
    style: `/public/plans/${token}/style.json`,
    transformRequest: (url) =>
      url.startsWith("/") || url.startsWith(location.origin) ? { url, credentials: "include" } : { url },
  });
  map.addControl(new maplibregl.NavigationControl(), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

  const applyCameraBounds = () => {
    const src = (map.getStyle()?.sources ?? {}) as Record<string, { bounds?: number[] }>;
    const b = src.sat?.bounds ?? src.grid?.bounds;
    if (!b || b.length !== 4) return;
    const padX = (b[2] - b[0]) * 0.12;
    const padY = (b[3] - b[1]) * 0.12;
    map.setMaxBounds([
      [b[0] - padX, b[1] - padY],
      [b[2] + padX, b[3] + padY],
    ]);
    const cam = map.cameraForBounds([
      [b[0], b[1]],
      [b[2], b[3]],
    ]);
    if (cam?.zoom) map.setMinZoom(Math.max(0, cam.zoom - 0.5));
  };
  map.on("load", applyCameraBounds);
  map.on("style.load", applyCameraBounds);

  // Annotationen (nur Ansehen)
  const annotsEl = root.querySelector<HTMLDivElement>("#annots")!;
  annotsEl.innerHTML = annotations
    .map(
      (a) =>
        `<div class="annot" data-aid="${a.id}" style="width:${a.width}px"><div class="annot-body">${renderMarkdown(
          a.text || "",
        )}</div></div>`,
    )
    .join("");
  const positionAnnots = () => {
    for (const el of Array.from(annotsEl.children) as HTMLElement[]) {
      const a = annotations.find((x) => x.id === el.dataset.aid);
      if (!a) continue;
      const p = map.project([a.world_x, a.world_y]);
      el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    }
  };
  map.on("move", positionAnnots);
  map.on("load", positionAnnots);

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
      },
    })),
  });
  const sFC = (): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: [...strokes.values()].map((s) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: s.points },
      properties: { color: hex(s.color), width: s.width > 0 ? s.width : 2 },
    })),
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
  }

  map.on("load", async () => {
    await Promise.all([...new Set([...markers.values()].map((m) => m.sidc))].map(ensureIcon));
    void loadExtras();
    map.addSource("s", { type: "geojson", data: sFC() });
    map.addLayer({
      id: "s",
      type: "line",
      source: "s",
      paint: { "line-color": ["get", "color"], "line-width": ["get", "width"] },
      layout: { "line-cap": "round", "line-join": "round" },
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
      },
    });
    map.addLayer({
      id: "m",
      type: "symbol",
      source: "m",
      layout: {
        "icon-image": ["get", "sidc"],
        "icon-size": 0.8,
        "icon-rotate": ["get", "rot"],
        "icon-allow-overlap": true,
        "text-field": ["get", "label"],
        "text-optional": true,
        "text-size": 11,
        "text-anchor": "top",
        "text-offset": [0, 1.4],
      },
      paint: { "text-color": "#e6e9ee", "text-halo-color": "#000", "text-halo-width": 1.4 },
    });
  });

  const refreshM = async () => {
    await Promise.all([...new Set([...markers.values()].map((m) => m.sidc))].map(ensureIcon));
    (map.getSource("m") as GeoJSONSource)?.setData(mFC());
  };
  const refreshS = () => (map.getSource("s") as GeoJSONSource)?.setData(sFC());

  // Empfangs-WebSocket für Live-Updates
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/public/plans/${token}/live`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "marker.upsert") {
      markers.set(msg.marker.id, msg.marker);
      void refreshM();
    } else if (msg.type === "marker.delete") {
      markers.delete(msg.id);
      void refreshM();
    } else if (msg.type === "stroke.upsert") {
      strokes.set(msg.stroke.id, msg.stroke);
      refreshS();
    } else if (msg.type === "stroke.delete") {
      strokes.delete(msg.id);
      refreshS();
    }
  };
  window.addEventListener("hashchange", () => ws.close(), { once: true });
}
