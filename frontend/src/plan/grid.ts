// Koordinaten-Grid (wie ATAKmaps): die Linien kommen aus dem gebackenen 'grid'-Raster-Layer (style.json),
// das Canvas zeichnet nur die bildschirmrand-verankerte Beschriftung.
import { lngLatToWorld, worldToLngLat } from "../sidc/sidc";
import type { PlanCtx } from "./ctx";

export function initGrid(ctx: PlanCtx): void {
  const { map, root, cal, baseLayerVisible, sig } = ctx;
  // ── Koordinaten-Grid (wie ATAKmaps) ───────────────────────────────────
  // Die Linien selbst kommen aus dem gebackenen 'grid'-Raster-Layer (style.json),
  // das Canvas zeichnet nur noch die bildschirmrand-verankerte Beschriftung.
  const gridCanvas = root.querySelector<HTMLCanvasElement>("#gridCanvas")!;
  const gctx = gridCanvas.getContext("2d")!;
  const GRID_LEVELS = [10, 100, 1000, 10000];
  const GRID_MIN_PX = 55;
  const GRID_MAX_LINES = 400;
  type GridLine = { axis: "x" | "y"; value: number; major: boolean; p0: [number, number]; p1: [number, number] };
  let gridLines: GridLine[] = [];

  const gridOn = () => baseLayerVisible.grid !== false;

  function resizeGridCanvas(): void {
    const r = map.getContainer().getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    gridCanvas.width = Math.round(r.width * dpr);
    gridCanvas.height = Math.round(r.height * dpr);
    gridCanvas.style.width = r.width + "px";
    gridCanvas.style.height = r.height + "px";
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function clipSeg(
    p0: [number, number],
    p1: [number, number],
    w: number,
    h: number,
  ): [[number, number], [number, number]] | null {
    let t0 = 0;
    let t1 = 1;
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const checks: [number, number][] = [
      [-dx, p0[0]],
      [dx, w - p0[0]],
      [-dy, p0[1]],
      [dy, h - p0[1]],
    ];
    for (const [p, q] of checks) {
      if (p === 0) {
        if (q < 0) return null;
        continue;
      }
      const rr = q / p;
      if (p < 0) {
        if (rr > t1) return null;
        if (rr > t0) t0 = rr;
      } else {
        if (rr < t0) return null;
        if (rr < t1) t1 = rr;
      }
    }
    return [
      [p0[0] + t0 * dx, p0[1] + t0 * dy],
      [p0[0] + t1 * dx, p0[1] + t1 * dy],
    ];
  }

  function edgeOf(pt: [number, number], w: number, h: number, eps = 1.5): string | null {
    if (pt[1] <= eps) return "top";
    if (pt[1] >= h - eps) return "bottom";
    if (pt[0] <= eps) return "left";
    if (pt[0] >= w - eps) return "right";
    return null;
  }

  function drawEdgeLabel(text: string, pt: [number, number], edge: string, major: boolean): void {
    const w = gridCanvas.clientWidth;
    const h = gridCanvas.clientHeight;
    gctx.font = major ? "600 11px monospace" : "500 10px monospace";
    const tw = gctx.measureText(text).width;
    let x = pt[0];
    let y = pt[1];
    if (edge === "top") {
      y += 11;
      x = Math.min(Math.max(x, tw / 2 + 4), w - tw / 2 - 4);
    } else if (edge === "bottom") {
      y -= 8;
      x = Math.min(Math.max(x, tw / 2 + 4), w - tw / 2 - 4);
    } else if (edge === "left") {
      x += 4 + tw / 2;
      y = Math.min(Math.max(y, 12), h - 8);
    } else {
      x -= 4 + tw / 2;
      y = Math.min(Math.max(y, 12), h - 8);
    }
    gctx.textAlign = "center";
    gctx.textBaseline = "middle";
    gctx.fillStyle = "rgba(0,0,0,0.55)";
    gctx.fillRect(x - tw / 2 - 3, y - 8, tw + 6, 16);
    gctx.fillStyle = major ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.7)";
    gctx.fillText(text, x, y);
  }

  function safeGame(px: number, py: number): [number, number] | null {
    const ll = map.unproject([px, py]);
    if (!isFinite(ll.lng) || !isFinite(ll.lat)) return null;
    const g = lngLatToWorld(cal, ll.lng, ll.lat);
    return isFinite(g[0]) && isFinite(g[1]) ? g : null;
  }

  // Horizon-sicher: bei gepitchter 3D-Ansicht landen Ecken oberhalb des Horizonts
  // auf riesigen/NaN-Koordinaten — dann per Bisektion zum Zentrum den sichtbaren
  // Schnittpunkt suchen.
  function visibleGame(
    px: number,
    py: number,
    center: [number, number, number, number],
    maxDist: number,
  ): [number, number] {
    const tooFar = (p: [number, number] | null) =>
      !p || Math.hypot(p[0] - center[0], p[1] - center[1]) > maxDist;
    const direct = safeGame(px, py);
    if (!tooFar(direct)) return direct as [number, number];
    let lo = 0;
    let hi = 1;
    let best: [number, number] = [center[0], center[1]];
    for (let i = 0; i < 12; i++) {
      const tt = (lo + hi) / 2;
      const p = safeGame(center[2] + (px - center[2]) * tt, center[3] + (py - center[3]) * tt);
      if (!tooFar(p)) {
        best = p as [number, number];
        lo = tt;
      } else {
        hi = tt;
      }
    }
    return best;
  }

  function updateGrid(): void {
    if (map.getLayer("grid")) {
      map.setLayoutProperty("grid", "visibility", gridOn() ? "visible" : "none");
    }
    if (!cal || !gridOn()) {
      gridLines = [];
      drawGridLabels();
      return;
    }
    const w = map.getContainer().clientWidth;
    const h = map.getContainer().clientHeight;
    if (!w || !h) return;

    const c0 = map.unproject([w / 2, h / 2]);
    const c1 = map.unproject([w / 2 + 1, h / 2]);
    const g0 = lngLatToWorld(cal, c0.lng, c0.lat);
    const g1 = lngLatToWorld(cal, c1.lng, c1.lat);
    const mpp = Math.hypot(g1[0] - g0[0], g1[1] - g0[1]) || 1;

    let mi = GRID_LEVELS.findIndex((lvl) => lvl / mpp >= GRID_MIN_PX);
    if (mi === -1) mi = GRID_LEVELS.length - 1;
    const minor = GRID_LEVELS[mi];
    const major = GRID_LEVELS[Math.min(mi + 1, GRID_LEVELS.length - 1)];
    const labelMinor = minor >= 100;

    const center: [number, number, number, number] = [g0[0], g0[1], w / 2, h / 2];
    const maxDist = Math.max(minor * 200, 5000);
    const corners = ([[0, 0], [w, 0], [0, h], [w, h]] as [number, number][]).map(([px, py]) =>
      visibleGame(px, py, center, maxDist),
    );
    const m2 = minor * 2;
    const minX = Math.min(...corners.map((c) => c[0])) - m2;
    const maxX = Math.max(...corners.map((c) => c[0])) + m2;
    const minY = Math.min(...corners.map((c) => c[1])) - m2;
    const maxY = Math.max(...corners.map((c) => c[1])) + m2;
    if (minX > maxX || minY > maxY) {
      gridLines = [];
      drawGridLabels();
      return;
    }

    const lines: GridLine[] = [];
    const collect = (axis: "x" | "y", spacing: number, isMajor: boolean) => {
      const lo = axis === "x" ? minX : minY;
      const hi = axis === "x" ? maxX : maxY;
      const tLo = axis === "x" ? minY : minX;
      const tHi = axis === "x" ? maxY : maxX;
      let drawn = 0;
      for (let v = Math.floor(lo / spacing) * spacing; v <= hi; v += spacing) {
        if (++drawn > GRID_MAX_LINES) break;
        if (!isMajor && spacing !== major && Math.abs(v % major) < 1e-6) continue;
        if (!isMajor && !labelMinor) continue;
        const a = axis === "x" ? worldToLngLat(cal, v, tLo) : worldToLngLat(cal, tLo, v);
        const b = axis === "x" ? worldToLngLat(cal, v, tHi) : worldToLngLat(cal, tHi, v);
        lines.push({ axis, value: v, major: isMajor, p0: a, p1: b });
      }
    };
    if (minor !== major) {
      collect("x", minor, false);
      collect("y", minor, false);
    }
    collect("x", major, true);
    collect("y", major, true);
    gridLines = lines;
    drawGridLabels();
  }

  function drawGridLabels(): void {
    const w = gridCanvas.clientWidth;
    const h = gridCanvas.clientHeight;
    if (!w || !h) return;
    gctx.clearRect(0, 0, w, h);
    if (!gridOn() || !gridLines.length) return;
    for (const line of gridLines) {
      const s0 = map.project(line.p0);
      const s1 = map.project(line.p1);
      const seg = clipSeg([s0.x, s0.y], [s1.x, s1.y], w, h);
      if (!seg) continue;
      const label = (line.axis === "x" ? "X " : "Y ") + Math.round(line.value);
      for (const pt of seg) {
        const edge = edgeOf(pt, w, h);
        if (edge) drawEdgeLabel(label, pt, edge, line.major);
      }
    }
  }

  let gridRaf = 0;
  const scheduleGridLabels = () => {
    if (gridRaf) return;
    gridRaf = requestAnimationFrame(() => {
      gridRaf = 0;
      drawGridLabels();
    });
  };
  resizeGridCanvas();
  map.on("moveend", updateGrid);
  map.on("move", scheduleGridLabels);
  map.on("resize", () => {
    resizeGridCanvas();
    updateGrid();
  });
  window.addEventListener(
    "resize",
    () => {
      resizeGridCanvas();
      updateGrid();
    },
    { signal: sig },
  );
  map.on("style.load", updateGrid);
  map.once("idle", updateGrid);
  ctx.ui.updateGrid = updateGrid;
}
