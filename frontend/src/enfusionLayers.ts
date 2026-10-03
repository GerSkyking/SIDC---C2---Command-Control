// Enfusion-TopoExport-Layer (Gebaeude, Strassen, Gewaesser, Stromleitungen, Baeume).
// Kommen fertig als GeoJSON aus dem ATAKmaps-Mappack (pipeline/enfusion_layers.py).
// Gemeinsam genutzt von plan.ts (Editor) und publicview.ts (oeffentliche Ansicht).
import type { Map as MlMap, LayerSpecification } from "maplibre-gl";

export const ENFUSION_KEYS = ["buildings", "roads", "water", "powerlines", "trees"] as const;
export type EnfusionKey = (typeof ENFUSION_KEYS)[number];

interface Def {
  spec: Record<string, unknown>;
  /** Paint-Eigenschaft, die der Deckkraft-Regler steuert */
  prop: string;
  /** Basis-Deckkraft (Regler = Faktor darauf) */
  base: number;
}

const DEFS: Record<EnfusionKey, Def[]> = {
  buildings: [
    {
      spec: {
        id: "buildings-fence", type: "fill", minzoom: 14,
        filter: ["==", ["get", "fence"], true],
        paint: { "fill-color": "#a89c86", "fill-opacity": 0.5 },
      },
      prop: "fill-opacity", base: 0.5,
    },
    {
      spec: {
        id: "buildings-fill", type: "fill",
        filter: ["!=", ["get", "fence"], true],
        paint: { "fill-color": "#d8c7a3", "fill-outline-color": "#3a2f1c", "fill-opacity": 0.9 },
      },
      prop: "fill-opacity", base: 0.9,
    },
  ],
  roads: [
    {
      // Start-/Landebahn + Hauptstrasse schwarz, Nebenstrasse dunkelbraun, Pfade grau.
      // Breite in Metern -> Pixel (verdoppelt sich je Zoomstufe).
      spec: {
        id: "roads-line", type: "line",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": ["match", ["get", "typeName"], "runway", "#000000", "main", "#000000", "secondary", "#4a2e14", "#8c8c8c"],
          "line-width": ["interpolate", ["exponential", 2], ["zoom"], 10, ["max", 0.6, ["*", ["get", "width"], 0.0131]], 20, ["*", ["get", "width"], 13.4]],
          "line-opacity": 1,
        },
      },
      prop: "line-opacity", base: 1,
    },
  ],
  water: [
    {
      spec: {
        id: "water-fill", type: "fill",
        paint: { "fill-color": "#3f8fd8", "fill-opacity": 0.7, "fill-antialias": false },
      },
      prop: "fill-opacity", base: 0.7,
    },
  ],
  powerlines: [
    {
      spec: {
        id: "powerlines-line", type: "line", filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-join": "round" },
        paint: { "line-color": "#000000", "line-width": 1.2, "line-opacity": 1 },
      },
      prop: "line-opacity", base: 1,
    },
    {
      spec: {
        id: "powerlines-poles", type: "circle", minzoom: 12, filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-color": "#000000",
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 1.2, 18, 3.5],
          "circle-opacity": 1,
        },
      },
      prop: "circle-opacity", base: 1,
    },
  ],
  trees: [
    {
      spec: {
        id: "trees-circle", type: "circle", minzoom: 13,
        paint: {
          "circle-color": "#2e8b3a",
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 1, 18, 4],
          "circle-opacity": 0.75,
        },
      },
      prop: "circle-opacity", base: 0.75,
    },
  ],
};

/** Logischer Layer -> MapLibre-Layer-IDs. */
export const ENFUSION_MAPLIBRE_IDS: Record<EnfusionKey, string[]> = Object.fromEntries(
  ENFUSION_KEYS.map((k) => [k, DEFS[k].map((d) => d.spec.id as string)]),
) as Record<EnfusionKey, string[]>;

/** Optional: GeoJSON fuer `key` laden (null = Karte hat den Layer nicht). */
export async function addEnfusionLayers(
  map: MlMap,
  urlFor: (key: EnfusionKey) => string,
  beforeId?: string,
): Promise<EnfusionKey[]> {
  const present: EnfusionKey[] = [];
  for (const key of ENFUSION_KEYS) {
    try {
      const r = await fetch(urlFor(key), { credentials: "include" });
      if (!r.ok) continue;
      map.addSource(key, { type: "geojson", data: await r.json() });
      for (const d of DEFS[key]) {
        const layer = {
          ...d.spec,
          source: key,
          layout: { ...((d.spec.layout as object) ?? {}), visibility: "none" },
        } as unknown as LayerSpecification;
        map.addLayer(layer, beforeId);
      }
      present.push(key);
    } catch {
      /* Layer nicht vorhanden */
    }
  }
  return present;
}

export function setEnfusionOpacity(map: MlMap, key: EnfusionKey, f: number): void {
  for (const d of DEFS[key]) {
    const id = d.spec.id as string;
    if (map.getLayer(id)) map.setPaintProperty(id, d.prop, d.base * f);
  }
}
