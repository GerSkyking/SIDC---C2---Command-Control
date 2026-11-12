// HUD und Kartensteuerung: Cursor-Koordinaten/Höhe (DEM-Kacheln bzw. Terrain), „Zeigen“ (Hervorhebung/Pfeil
// für andere), 2D/3D + Navigations-Würfel, Kompass sowie die persönlichen Marker-/Textgrößen-Regler.
import { makeMovable } from "../movable";
import { initNavCube } from "../navcube";
import { wireScaleBox } from "../scalebox";
import { lngLatToWorld } from "../sidc/sidc";
import { wireThemeSwitch } from "../ui";
import type { PlanCtx } from "./ctx";

export function initHud(ctx: PlanCtx): void {
  const { map, socket, root, planId, mapId, cal, me, peers, sig } = ctx;
  const { upsertPeer } = ctx.model;
  // ── Höhe aus den DEM-Kacheln lesen (terrarium-Encoding) ───────────────
  // Funktioniert auch ohne aktives Terrain-Mesh — so bleibt 2D ressourcenschonend.
  let demZoom = 0;
  const demImg = new Map<string, ImageData | null>();
  const demBusy = new Set<string>();
  const DEM_MAX = 48; // ~48 Kacheln (je ~256 KB) im Speicher, älteste fliegen raus
  const demSet = (key: string, v: ImageData | null): void => {
    demImg.delete(key);
    demImg.set(key, v);
    if (demImg.size > DEM_MAX) demImg.delete(demImg.keys().next().value as string);
  };
  const sampleElevation = (lng: number, lat: number): number | null => {
    if (!demZoom) {
      const ts = (() => {
        try {
          return map.getStyle()?.sources?.["terrain-dem"] as
            | { minzoom?: number; maxzoom?: number }
            | undefined;
        } catch {
          return undefined;
        }
      })();
      if (!ts) return null;
      demZoom = Math.min(ts.maxzoom ?? 12, Math.max(ts.minzoom ?? 0, 12));
    }
    const n = 2 ** demZoom;
    const xf = ((lng + 180) / 360) * n;
    const latR = (lat * Math.PI) / 180;
    const yf = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
    const tx = Math.floor(xf);
    const ty = Math.floor(yf);
    if (tx < 0 || ty < 0 || tx >= n || ty >= n) return null;
    const key = `${demZoom}/${tx}/${ty}`;
    const img = demImg.get(key);
    if (img === undefined) {
      if (!demBusy.has(key)) {
        demBusy.add(key);
        const im = new Image();
        im.crossOrigin = "anonymous";
        im.onload = () => {
          try {
            const c = document.createElement("canvas");
            c.width = im.naturalWidth;
            c.height = im.naturalHeight;
            const cx = c.getContext("2d", { willReadFrequently: true })!;
            cx.drawImage(im, 0, 0);
            demSet(key, cx.getImageData(0, 0, c.width, c.height));
          } catch {
            demSet(key, null);
          }
          demBusy.delete(key);
        };
        im.onerror = () => {
          demSet(key, null);
          demBusy.delete(key);
        };
        im.src = `/api/maps/${mapId}/terrain/${demZoom}/${tx}/${ty}.png`;
      }
      return null;
    }
    if (img === null) return null;
    const px = Math.min(img.width - 1, Math.max(0, Math.floor((xf - tx) * img.width)));
    const py = Math.min(img.height - 1, Math.max(0, Math.floor((yf - ty) * img.height)));
    const i = (py * img.width + px) * 4;
    return img.data[i] * 256 + img.data[i + 1] + img.data[i + 2] / 256 - 32768;
  };

  ctx.ui.sampleElevation = sampleElevation;

  // ── HUD (Cursor X/Y/Höhe) ──────────────────────────────────────────────
  const hud = root.querySelector<HTMLDivElement>("#hud")!;
  makeMovable(hud, { plan: planId, key: "hud" });
  makeMovable(root.querySelector<HTMLDivElement>("#mkScale")!, { plan: planId, key: "mkscale" });
  let lastCursorSent = 0;
  map.on("mousemove", (e) => {
    ctx.hoverLngLat = { lng: e.lngLat.lng, lat: e.lngLat.lat };
    const [wx, wy] = lngLatToWorld(cal, e.lngLat.lng, e.lngLat.lat);
    let h = "–";
    try {
      const el = ctx.is3D
        ? (map.queryTerrainElevation(e.lngLat) ?? 0) / 1.5
        : sampleElevation(e.lngLat.lng, e.lngLat.lat);
      if (el != null) h = `${Math.round(el)} m`;
    } catch {
      /* keine Höhendaten */
    }
    hud.textContent = `X: ${wx.toFixed(0)}  Y: ${wy.toFixed(0)}  H: ${h}`;
    trackCursor(e.lngLat.lng, e.lngLat.lat);
  });
  // Vorschau-Linie / Messlinie / Zeiger folgen dem Zeiger bzw. dem Finger
  const trackCursor = (lng: number, lat: number) => {
    if (ctx.mode === "measure" && ctx.measureActive.length) {
      ctx.measureCursor = [lng, lat];
      ctx.ui.redrawMeasure();
    }
    if (ctx.mode === "point") sendPointer(lng, lat);
    if (ctx.mode === "line" && ctx.linePts.length) {
      ctx.lineCursor = [lng, lat];
      ctx.ui.refreshLineDraft(); // inkl. Hervorhebung des Startpunkts (Fläche schließen)
    }
  };
  map.on("touchmove", (e) => {
    if (e.points.length === 1) trackCursor(e.lngLat.lng, e.lngLat.lat);
  });
  // Zeigen: Linksklick = gelbe Hervorhebung, Rechtsklick halten + ziehen = Pfeil (nur solange gehalten)
  let ptrHl = false;
  let ptrArrowFrom: [number, number] | null = null;
  let ptrLast: [number, number] | null = null;
  const sendPointer = (lng: number, lat: number, force = false) => {
    if (!force && Date.now() - lastCursorSent <= 60) return;
    lastCursorSent = Date.now();
    ptrLast = [lng, lat];
    socket.send({ type: "presence.cursor", lng, lat, hl: ptrHl, arrow: ptrArrowFrom });
    // eigener Zeiger auch bei mir anzeigen
    upsertPeer(me.id, me.display_name || me.username, lng, lat, ptrHl, ptrArrowFrom);
    ctx.ui.refreshPeers();
  };
  map.on("mousedown", (e) => {
    if (ctx.mode !== "point") return;
    if (e.originalEvent.button === 0) ptrHl = true;
    else if (e.originalEvent.button === 2) ptrArrowFrom = [e.lngLat.lng, e.lngLat.lat];
    else return;
    sendPointer(e.lngLat.lng, e.lngLat.lat, true);
  });
  const releasePtr = () => {
    if (!ptrHl && !ptrArrowFrom) return;
    ptrHl = false;
    ptrArrowFrom = null;
    if (ctx.mode === "point" && ptrLast) sendPointer(ptrLast[0], ptrLast[1], true);
  };
  document.addEventListener("mouseup", releasePtr, { signal: sig });
  // Werkzeugwechsel weg von „Zeigen“: Hervorhebung/Pfeil beenden, eigenen Zeiger entfernen
  ctx.ui.resetPointer = () => {
    ptrHl = false;
    if (ptrArrowFrom) {
      ptrArrowFrom = null;
      if (ptrLast) sendPointer(ptrLast[0], ptrLast[1], true); // Pfeil bei den anderen beenden
    }
    if (peers.has(me.id)) {
      peers.delete(me.id);
      ctx.ui.refreshPeers();
    }
  };
  // Touch: Zeigen folgt dem Finger (ein Finger); ein zweiter Finger beendet es und navigiert die Karte
  map.on("touchstart", (e) => {
    if (ctx.mode !== "point") return;
    if (e.points.length !== 1) return releasePtr();
    ptrHl = true;
    sendPointer(e.lngLat.lng, e.lngLat.lat, true);
  });
  document.addEventListener("touchend", () => releasePtr(), { signal: sig });
  document.addEventListener("touchcancel", () => releasePtr(), { signal: sig });

  // ── 2D/3D + Navigations-Würfel ───────────────────────────────────────
  const navcube = root.querySelector<HTMLDivElement>("#navcube")!;
  wireScaleBox(root);
  initNavCube(map, navcube); // immer sichtbar (2D + 3D)
  navcube.hidden = false;

  root.querySelector("#t3d")!.addEventListener("click", () => {
    ctx.is3D = !ctx.is3D;
    root.querySelector("#t3d")!.classList.toggle("active", ctx.is3D);
    const hasDem = !!map.getSource("terrain-dem");
    if (ctx.is3D) {
      if (hasDem) map.setTerrain({ source: "terrain-dem", exaggeration: 1.5 });
      map.setMaxPitch(85);
      map.easeTo({ pitch: 60, duration: 700 });
    } else {
      // 2D: Terrain-Mesh abschalten → deutlich ressourcenschonender.
      map.easeTo({ pitch: 0, duration: 700 });
      map.once("moveend", () => {
        if (!ctx.is3D) {
          if (hasDem) map.setTerrain(null);
          map.setMaxPitch(0); // Kippen wieder sperren, Drehung bleibt
        }
      });
    }
  });

  // ── Kompass + Nach-Norden-Button ──────────────────────────────────────
  wireThemeSwitch(root);
  const compass = root.querySelector<HTMLButtonElement>("#compass")!;
  const syncCompass = () => {
    compass.style.setProperty("--rot", `${-map.getBearing()}deg`);
  };
  map.on("rotate", syncCompass);
  map.on("load", syncCompass);
  compass.addEventListener("click", () => map.easeTo({ bearing: 0, duration: 400 }));
  {
    const si = root.querySelector<HTMLInputElement>("#mkScaleIn")!;
    const sv = root.querySelector<HTMLSpanElement>("#mkScaleV")!;
    si.addEventListener("input", () => {
      ctx.personalScale = Number(si.value) / 100 || 1;
      sv.textContent = `${si.value}%`;
      try {
        localStorage.setItem("sidc_marker_scale", String(ctx.personalScale));
      } catch {
        /* ignore */
      }
      void ctx.ui.refreshMarkers();
    });
  }
  {
    const si = root.querySelector<HTMLInputElement>("#mkTextScaleIn")!;
    const sv = root.querySelector<HTMLSpanElement>("#mkTextScaleV")!;
    si.addEventListener("input", () => {
      ctx.textScale = Number(si.value) / 100 || 1;
      sv.textContent = `${si.value}%`;
      try {
        localStorage.setItem("sidc_text_scale", String(ctx.textScale));
      } catch {
        /* ignore */
      }
      map.setLayoutProperty("marker-unittext", "text-size", 11 * ctx.textScale);
      map.setLayoutProperty("marker-aitext", "text-size", 11 * ctx.textScale);
      map.setLayoutProperty("marker-textmark", "text-size", 14 * ctx.textScale);
      void ctx.ui.refreshMarkers(); // Text-Offsets neu berechnen, sonst rückt der Text vom Icon weg
    });
  }
}
