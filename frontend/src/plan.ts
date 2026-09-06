// Plan-Ansicht: MapLibre-Karte, Klick setzt Marker, Live-Sync über WebSocket.
// Voller SIDC-/Zeichnen-/Phasen-/Layer-Editor folgt in späteren Phasen (siehe PLAN.md);
// dies ist die minimale kollaborative Marker-Ebene für den ersten Test.
import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import { api, type Me } from "./api";
import { cid, PlanSocket, type WsMessage } from "./ws";

interface Marker {
  id: string;
  world_x: number;
  world_y: number;
  sidc: string;
  unit_text: string;
  locked: boolean;
}

export async function openPlanView(root: HTMLElement, planId: string, me: Me): Promise<void> {
  const snap = await api.snapshot(planId);
  const mapId: string = snap.plan.map_id;
  const markers = new Map<string, Marker>();
  for (const m of snap.markers) markers.set(m.id, m);

  const myPlan = (await api.plans()).find((p) => p.id === planId);
  const canEdit = myPlan?.level === "editor" || myPlan?.level === "owner";
  const peers = new Set<string>();

  root.innerHTML = `
    <div class="topbar">
      <a href="#/">← Pläne</a>
      <strong>${snap.plan.name}</strong>
      <span class="badge">${myPlan?.level ?? "?"}</span>
      <span class="grow"></span>
      <span class="presence" id="presence"></span>
      ${canEdit ? `<button id="save">Version speichern</button>` : ""}
      <span class="muted" id="hint">${canEdit ? "Klick auf die Karte setzt einen Marker" : "Nur Lesezugriff"}</span>
    </div>
    <div id="map"></div>`;

  // center/zoom kommen aus der style.json (pro Karte gesetzt).
  const map = new maplibregl.Map({ container: "map", style: `/api/maps/${mapId}/style.json` });

  map.on("load", () => {
    map.addSource("markers", { type: "geojson", data: featureCollection(markers) });
    map.addLayer({
      id: "marker-dot",
      type: "circle",
      source: "markers",
      paint: {
        "circle-radius": 7,
        "circle-color": ["case", ["get", "locked"], "#c94", "#4c8dff"],
        "circle-stroke-width": 2,
        "circle-stroke-color": "#fff",
      },
    });
    map.addLayer({
      id: "marker-label",
      type: "symbol",
      source: "markers",
      layout: {
        "text-field": ["get", "label"],
        "text-offset": [0, 1.2],
        "text-size": 12,
      },
      paint: { "text-color": "#e6e9ee", "text-halo-color": "#000", "text-halo-width": 1 },
    });
  });

  const refresh = () =>
    (map.getSource("markers") as GeoJSONSource)?.setData(featureCollection(markers));

  const socket = new PlanSocket(planId);
  socket.on((msg: WsMessage) => {
    switch (msg.type) {
      case "presence.join":
        if (msg.uid !== me.id) peers.add(msg.user);
        renderPresence();
        break;
      case "presence.leave":
        // Namen nicht bekannt -> einfache Neuberechnung überspringen; nur Anzeige leeren bei 0
        break;
      case "marker.upsert":
        markers.set(msg.marker.id, msg.marker);
        refresh();
        break;
      case "marker.delete":
        markers.delete(msg.id);
        refresh();
        break;
    }
  });
  socket.connect();

  const presenceEl = root.querySelector<HTMLSpanElement>("#presence")!;
  const renderPresence = () =>
    (presenceEl.innerHTML = [...peers].map((n) => `<span class="badge">${n}</span>`).join(""));

  if (canEdit) {
    map.on("click", (e) => {
      socket.send({
        type: "marker.create",
        cid: cid(),
        data: {
          sidc: "10012500001101000000",
          world_x: e.lngLat.lng,
          world_y: e.lngLat.lat,
          unit_text: "",
        },
      });
    });
    map.on("mouseenter", "marker-dot", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "marker-dot", () => (map.getCanvas().style.cursor = ""));
    map.on("click", "marker-dot", (e) => {
      e.preventDefault();
      const id = e.features?.[0]?.properties?.id as string;
      if (id && confirm("Marker löschen?")) socket.send({ type: "marker.delete", id });
    });
  }

  root.querySelector("#save")?.addEventListener("click", async () => {
    const label = prompt("Bezeichnung der Version:") ?? "";
    await api.saveVersion(planId, label);
    alert("Version gespeichert");
  });

  window.addEventListener("hashchange", () => socket.close(), { once: true });
}

function featureCollection(markers: Map<string, Marker>): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [...markers.values()].map((m) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [m.world_x, m.world_y] },
      properties: { id: m.id, locked: m.locked, label: m.unit_text || m.sidc.slice(0, 6) },
    })),
  };
}
