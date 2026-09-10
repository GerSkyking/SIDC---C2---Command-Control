// Screenshot-Optionen (Auflösung + Format) — geteilt von plan.ts und publicview.ts.
import type { Map as MlMap } from "maplibre-gl";
import { t } from "./i18n";

export type ShotFormat = "png" | "jpeg" | "webp";
export type ShotRes = "current" | "1920" | "2560" | "3840";

export interface ShotOpts {
  res: ShotRes;
  fmt: ShotFormat;
}

const RES_PX: Record<Exclude<ShotRes, "current">, [number, number]> = {
  "1920": [1920, 1080],
  "2560": [2560, 1440],
  "3840": [3840, 2160],
};
const STORE = "sidc_shot_opts";

export function loadShotOpts(): ShotOpts {
  try {
    const o = JSON.parse(localStorage.getItem(STORE) || "");
    if (o && typeof o === "object") return { res: o.res ?? "current", fmt: o.fmt ?? "png" };
  } catch {
    /* ignore */
  }
  return { res: "current", fmt: "png" };
}
function save(o: ShotOpts): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(o));
  } catch {
    /* ignore */
  }
}

export function mimeExt(fmt: ShotFormat): { mime: string; ext: string; quality?: number } {
  if (fmt === "jpeg") return { mime: "image/jpeg", ext: "jpg", quality: 0.92 };
  if (fmt === "webp") return { mime: "image/webp", ext: "webp", quality: 0.92 };
  return { mime: "image/png", ext: "png" };
}

/** Caret-Button + Optionspanel, direkt hinter den Kamera-Button einsetzen. */
export function shotOptsMarkup(): string {
  return `
    <button id="shotOpts" class="shot-caret" title="${t("shot.options")}" aria-haspopup="true">▾</button>
    <div id="shotOptsPanel" class="shot-opts" hidden>
      <label>${t("shot.resolution")}
        <select data-so="res">
          <option value="current">${t("shot.current")}</option>
          <option value="1920">1920 × 1080</option>
          <option value="2560">2560 × 1440</option>
          <option value="3840">3840 × 2160</option>
        </select></label>
      <label>${t("shot.format")}
        <select data-so="fmt">
          <option value="png">PNG</option>
          <option value="jpeg">JPEG</option>
          <option value="webp">WebP</option>
        </select></label>
    </div>`;
}

/** Verdrahtet Panel + Persistenz. Gibt einen Getter für die aktuellen Optionen zurück. */
export function wireShotOpts(root: HTMLElement): () => ShotOpts {
  const caret = root.querySelector<HTMLButtonElement>("#shotOpts")!;
  const panel = root.querySelector<HTMLElement>("#shotOptsPanel")!;
  const resSel = panel.querySelector<HTMLSelectElement>('[data-so="res"]')!;
  const fmtSel = panel.querySelector<HTMLSelectElement>('[data-so="fmt"]')!;
  const cur = loadShotOpts();
  resSel.value = cur.res;
  fmtSel.value = cur.fmt;

  caret.addEventListener("click", (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!panel.hidden && !panel.contains(e.target as Node) && e.target !== caret) panel.hidden = true;
  });
  const persist = () => save({ res: resSel.value as ShotRes, fmt: fmtSel.value as ShotFormat });
  resSel.addEventListener("change", persist);
  fmtSel.addEventListener("change", persist);

  return () => ({ res: resSel.value as ShotRes, fmt: fmtSel.value as ShotFormat });
}

/**
 * Rendert die Karte in eine 2D-Canvas. Bei fester Auflösung wird der
 * Karten-Container kurz auf Zielgröße gesetzt (offscreen), gerendert und
 * danach zurückgestellt. Die Canvas hat das Zielpixelmaß.
 */
export async function renderMapCanvas(map: MlMap, res: ShotRes): Promise<HTMLCanvasElement> {
  const idle = () =>
    new Promise<void>((r) => {
      if (map.loaded() && !map.isMoving()) return r();
      map.once("idle", () => r());
      map.triggerRepaint();
    });

  const container = map.getContainer();
  const dpr = window.devicePixelRatio || 1;

  let restore: (() => void) | null = null;
  if (res !== "current") {
    const [tw, th] = RES_PX[res];
    const prev = container.style.cssText;
    Object.assign(container.style, {
      position: "fixed",
      left: "-99999px",
      top: "0",
      width: `${Math.round(tw / dpr)}px`,
      height: `${Math.round(th / dpr)}px`,
      zIndex: "-1",
    });
    map.resize();
    restore = () => {
      container.style.cssText = prev;
      map.resize();
    };
  }

  try {
    await idle();
    map.redraw();
    const mc = map.getCanvas();
    const out = document.createElement("canvas");
    out.width = mc.width;
    out.height = mc.height;
    out.getContext("2d")!.drawImage(mc, 0, 0);
    return out;
  } finally {
    restore?.();
  }
}
