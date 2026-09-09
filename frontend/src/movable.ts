// Verschiebbare Karten-Panels mit optionalem Pin (bleibt offen / an Ort) —
// Position + Pin-Status je Plan/Browser gespeichert (User-Preset).
import { t } from "./i18n";
import { icon } from "./icons";

export interface Movable {
  isPinned: () => boolean;
  hasPos: () => boolean;
  resetPos: () => void;
}

export function makeMovable(
  el: HTMLElement,
  opts: { plan: string; key: string; pinnable?: boolean },
): Movable {
  const posKey = `sidc_ui_${opts.plan}_${opts.key}`;
  const pinKey = `sidc_uipin_${opts.plan}_${opts.key}`;

  const bar = document.createElement("div");
  bar.className = "mv-bar";
  bar.innerHTML =
    `<span class="mv-grip">${icon("drag", 14)}</span>` +
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

  const applyPos = () => {
    try {
      const p = JSON.parse(localStorage.getItem(posKey) || "null");
      if (p && typeof p.x === "number") {
        el.style.left = `${Math.max(0, Math.min(window.innerWidth - 40, p.x))}px`;
        el.style.top = `${Math.max(0, Math.min(window.innerHeight - 24, p.y))}px`;
        el.style.right = "auto";
        el.style.bottom = "auto";
      }
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
      try {
        localStorage.setItem(
          posKey,
          JSON.stringify({ x: parseInt(el.style.left), y: parseInt(el.style.top) }),
        );
      } catch {
        /* ignore */
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  return {
    isPinned: () => pinned,
    hasPos: () => {
      try {
        return !!localStorage.getItem(posKey);
      } catch {
        return false;
      }
    },
    resetPos: () => {
      try {
        localStorage.removeItem(posKey);
      } catch {
        /* ignore */
      }
      el.style.left = el.style.top = "";
      el.style.right = el.style.bottom = "";
    },
  };
}
