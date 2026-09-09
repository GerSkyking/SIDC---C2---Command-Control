// Verschiebbare Karten-Panels mit optionalem Pin (bleibt offen / an Ort) —
// Position + Pin-Status je Plan/Browser gespeichert (User-Preset).
import { t } from "./i18n";
import { icon } from "./icons";

export interface Movable {
  isPinned: () => boolean;
  hasPos: () => boolean;
  resetPos: () => void;
  /** Sicherstellen, dass das Panel (wieder) im sichtbaren Bereich liegt. */
  bringIntoView: () => void;
}

// Mindestens so viel vom Panel muss auf dem Bildschirm bleiben:
const KEEP_X = 140;
const KEEP_Y = 70;

export function makeMovable(
  el: HTMLElement,
  opts: { plan: string; key: string; pinnable?: boolean },
): Movable {
  const posKey = `sidc_ui_${opts.plan}_${opts.key}`;
  const pinKey = `sidc_uipin_${opts.plan}_${opts.key}`;

  const bar = document.createElement("div");
  bar.className = "mv-bar";
  bar.innerHTML =
    `<span class="mv-grip" title="${t("ui.dragHint")}">${icon("drag", 14)}</span>` +
    (opts.pinnable
      ? `<button type="button" class="mv-pin" title="${t("ui.pin")}">${icon("pin", 14)}</button>`
      : "");
  el.prepend(bar);
  el.classList.add("mv");

  // Panel-Inhalte werden teils per innerHTML neu aufgebaut (Favoriten, ORBAT,
  // Ebenen) — dabei geht die Leiste verloren. Wieder einsetzen, sobald das passiert.
  const ensureBar = () => {
    if (el.firstChild !== bar) {
      el.prepend(bar);
      applyPin();
    }
  };
  new MutationObserver(ensureBar).observe(el, { childList: true });

  const readPin = () => {
    try {
      return localStorage.getItem(pinKey) === "1";
    } catch {
      return false;
    }
  };
  let pinned = readPin();
  const applyPin = () => {
    el.classList.toggle("mv-pinned", pinned);
    bar.querySelector(".mv-pin")?.classList.toggle("on", pinned);
  };
  applyPin();

  const clampX = (x: number) => Math.max(4, Math.min(window.innerWidth - KEEP_X, x));
  const clampY = (y: number) => Math.max(4, Math.min(window.innerHeight - KEEP_Y, y));
  const savePos = (x: number, y: number) => {
    try {
      localStorage.setItem(posKey, JSON.stringify({ x: Math.round(x), y: Math.round(y) }));
    } catch {
      /* ignore */
    }
  };
  const place = (x: number, y: number, persist = false) => {
    const cx = clampX(x);
    const cy = clampY(y);
    el.style.left = `${cx}px`;
    el.style.top = `${cy}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
    if (persist) savePos(cx, cy);
  };

  const applyPos = () => {
    try {
      const p = JSON.parse(localStorage.getItem(posKey) || "null");
      if (p && typeof p.x === "number") place(p.x, p.y);
    } catch {
      /* ignore */
    }
  };
  applyPos();

  bar.querySelector(".mv-pin")?.addEventListener("click", (e) => {
    e.stopPropagation();
    pinned = !pinned;
    try {
      localStorage.setItem(pinKey, pinned ? "1" : "0");
    } catch {
      /* ignore */
    }
    applyPin();
  });

  const grip = bar.querySelector<HTMLElement>(".mv-grip")!;
  grip.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const onMove = (ev: MouseEvent) => {
      el.style.left = `${ev.clientX - dx}px`;
      el.style.top = `${ev.clientY - dy}px`;
      el.style.right = "auto";
      el.style.bottom = "auto";
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      place(parseInt(el.style.left) || 0, parseInt(el.style.top) || 0, true);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
  // Doppelklick auf den Griff → Position zurücksetzen (falls das Panel verloren ging)
  grip.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    reset();
  });

  const reset = () => {
    try {
      localStorage.removeItem(posKey);
    } catch {
      /* ignore */
    }
    el.style.left = el.style.top = "";
    el.style.right = el.style.bottom = "";
  };

  return {
    isPinned: () => pinned,
    hasPos: () => {
      try {
        return !!localStorage.getItem(posKey);
      } catch {
        return false;
      }
    },
    resetPos: reset,
    bringIntoView: () => {
      const r = el.getBoundingClientRect();
      if (!r.width) return;
      const offscreen =
        r.right < 60 ||
        r.bottom < 60 ||
        r.left > window.innerWidth - 60 ||
        r.top > window.innerHeight - 40;
      if (offscreen) place(24, 72, true);
      else place(r.left, r.top, true);
    },
  };
}
