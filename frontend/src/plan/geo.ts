// Reine Hilfsfunktionen der Plan-Ansicht (ohne Zugriff auf den Plan-Zustand).

// Bild-URL -> JPEG-DataURL (normalisiert WebP/GIF/PNG für jsPDF).
export async function imgToJpeg(url: string): Promise<string> {
  const blob = await (await fetch(url, { credentials: "include" })).blob();
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0);
  return c.toDataURL("image/jpeg", 0.9);
}

export function packedToHex(packed: number): string {
  if (packed === undefined || packed === -1 || Number.isNaN(packed)) return "#ffd700";
  const n = packed & 0xffffff;
  return "#" + n.toString(16).padStart(6, "0");
}

export function emptyFC(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

export function lineDraftFC(pts: [number, number][], cursor: [number, number] | null = null): GeoJSON.FeatureCollection {
  const feats: GeoJSON.Feature[] = pts.map((p) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: p },
    properties: {},
  }));
  // Vorschau-Linie vom letzten Punkt zum Mauszeiger (wie beim Lineal)
  const trace = cursor && pts.length ? [...pts, cursor] : pts;
  if (trace.length >= 2) {
    feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: trace }, properties: {} });
  }
  return { type: "FeatureCollection", features: feats };
}

/** Server-Zeitstempel ohne Zone als UTC lesen. */
export const parseUtc = (s: string): number => Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z");

// Naive ISO-Zeit als lokale Wanduhr interpretieren (kein UTC-Versatz).
export const parseNaive = (s: string): Date => new Date(/[Z+]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(" ", "T"));
export const fmtInput = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const esc0 = (s: string) =>
  (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export const fmtDist = (mtr: number) => (mtr < 1000 ? `${Math.round(mtr)} m` : `${(mtr / 1000).toFixed(2)} km`);

// Bildschirm-Abstand Punkt ↔ Strecke / Polylinie (Radierer, Treffer-Tests)
export const distToSeg = (px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const tt = l2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2)) : 0;
  return Math.hypot(px - (a.x + tt * dx), py - (a.y + tt * dy));
};
export const polyHit = (px: number, py: number, pts: { x: number; y: number }[], r: number): boolean => {
  if (pts.length === 1) return Math.hypot(pts[0].x - px, pts[0].y - py) <= r;
  for (let i = 1; i < pts.length; i++) if (distToSeg(px, py, pts[i - 1], pts[i]) <= r) return true;
  return false;
};
