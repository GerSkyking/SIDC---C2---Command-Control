// Navigations-Würfel (ViewCube) für die 3D-Ansicht. Zeigt die aktuelle
// Orientierung und schwenkt die Kamera bei Klick:
//   Oben-Fläche  -> Top-Down (Pitch 0)
//   N/O/S/W      -> Blick aus der Richtung, Pitch 45°
//   Ecken NO/NW/SO/SW -> isometrischer Schrägblick (Bearing 45/135/225/315, Pitch 45°)
//   Home         -> Standardansicht (Norden, von oben)
//   Ziehen       -> Ansicht drehen; Achse wird auf die dominante Richtung gesperrt,
//                   damit seitliches Ziehen nicht ungewollt kippt.
// Extrahiert aus plan.ts / publicview.ts (war dort dupliziert).
import type { Map as MlMap } from "maplibre-gl";
import { t } from "./i18n";

const FACE_BEARING: Record<string, number> = {
  n: 0, e: 90, s: 180, w: 270, ne: 45, se: 135, sw: 225, nw: 315,
};

export interface NavCube {
  /** Bei Umschalten 2D/3D aufrufen. */
  setVisible(v: boolean): void;
  destroy(): void;
}

export function initNavCube(
  map: MlMap,
  el: HTMLElement,
  opts: { onHome?: () => void } = {},
): NavCube {
  el.classList.add("navcube");
  el.innerHTML = `
    <button class="navcube-home" title="${t("navcube.home")}">⌂</button>
    <div class="ncube-ring"><b>N</b></div>
    <div class="ncube">
      <button class="ncf ncf-top" data-face="top">▲</button>
      <button class="ncf ncf-n" data-face="n">N</button>
      <button class="ncf ncf-s" data-face="s">S</button>
      <button class="ncf ncf-e" data-face="e">O</button>
      <button class="ncf ncf-w" data-face="w">W</button>
    </div>
    <button class="ncc ncc-nw" data-face="nw" title="NW"></button>
    <button class="ncc ncc-ne" data-face="ne" title="NO"></button>
    <button class="ncc ncc-sw" data-face="sw" title="SW"></button>
    <button class="ncc ncc-se" data-face="se" title="SO"></button>`;

  const cube = el.querySelector<HTMLElement>(".ncube")!;
  const ring = el.querySelector<HTMLElement>(".ncube-ring")!;

  const sync = () => {
    const b = map.getBearing();
    cube.style.transform = `rotateX(${map.getPitch() - 90}deg) rotateZ(${b}deg)`;
    ring.style.transform = `rotate(${-b}deg)`;
  };
  map.on("rotate", sync);
  map.on("pitch", sync);
  map.on("load", sync);

  let dragged = false;

  el.querySelectorAll<HTMLButtonElement>("[data-face]").forEach((b) =>
    b.addEventListener("click", () => {
      if (dragged) {
        dragged = false;
        return;
      }
      const f = b.dataset.face!;
      if (f === "top") map.easeTo({ pitch: 0, duration: 500 });
      else map.easeTo({ bearing: FACE_BEARING[f], pitch: 45, duration: 500 });
    }),
  );

  const home = () => {
    if (opts.onHome) opts.onHome();
    else map.easeTo({ bearing: 0, pitch: 0, duration: 500 });
  };
  el.querySelector(".navcube-home")!.addEventListener("click", (e) => {
    e.stopPropagation();
    home();
  });

  // ── Ziehen mit Achsensperre ────────────────────────────────────────
  const onDown = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest(".navcube-home")) return;
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const sb = map.getBearing();
    const sp = map.getPitch();
    dragged = false;
    let axis: "b" | "p" | null = null;
    el.classList.add("drag");
    const mv = (ev: MouseEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!axis) {
        if (Math.abs(dx) + Math.abs(dy) < 4) return;
        axis = Math.abs(dx) >= Math.abs(dy) ? "b" : "p";
        dragged = true;
      }
      if (axis === "b") map.setBearing(sb + dx * 0.5);
      else map.setPitch(Math.max(0, Math.min(85, sp - dy * 0.35)));
    };
    const up = () => {
      document.removeEventListener("mousemove", mv);
      document.removeEventListener("mouseup", up);
      el.classList.remove("drag");
    };
    document.addEventListener("mousemove", mv);
    document.addEventListener("mouseup", up);
  };
  el.addEventListener("mousedown", onDown);

  sync();

  return {
    setVisible(v: boolean) {
      el.hidden = !v;
    },
    destroy() {
      map.off("rotate", sync);
      map.off("pitch", sync);
      map.off("load", sync);
      el.removeEventListener("mousedown", onDown);
    },
  };
}
