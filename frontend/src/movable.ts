// Verschiebbare Karten-Panels mit optionalem Pin (bleibt offen / an Ort) —
// Position, Größe + Pin-Status pro Benutzer gespeichert (Server, siehe uiStore.ts), in allen Plänen gleich.
import { t } from "./i18n";
import { uiGet, uiRemove, uiSet } from "./uiStore";
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
  opts: { plan: string; key: string; pinnable?: boolean; onClose?: () => void; resizable?: boolean },
): Movable {
  // Pro Benutzer (Browser), nicht pro Plan: gleiche Position/Größe/Anheftung in allen Plänen.
  // Alte plan-spezifische Werte dienen als Rückfall, bis neu gespeichert wird.
  const posKey = `sidc_ui_${opts.key}`;
  const pinKey = `sidc_uipin_${opts.key}`;
  const sizeKey = `sidc_uisize_${opts.key}`;
  const legacy = (k: string): string => k.replace(/^(sidc_ui(?:pin|size)?_)/, `$1${opts.plan}_`);
  const rd = (k: string): string | null => uiGet(k) ?? uiGet(legacy(k));

  const bar = document.createElement("div");
  bar.className = "mv-bar";
  bar.innerHTML =
    `<span class="mv-grip" title="${t("ui.dragHint")}">${icon("drag", 14)}</span>` +
    `<span class="mv-sp"></span>` +
    (opts.pinnable
      ? `<button type="button" class="mv-pin" title="${t("ui.pin")}">${icon("pin", 14)}</button>`
      : "") +
    (opts.pinnable || opts.onClose
      ? `<button type="button" class="mv-x" title="${t("common.close")}">${icon("x", 14)}</button>`
      : "");
  el.prepend(bar);
  el.classList.add("mv");

  const resizeHandle = opts.resizable ? document.createElement("div") : null;
  if (resizeHandle) {
    resizeHandle.className = "mv-resize";
    el.appendChild(resizeHandle);
  }

  // Panel-Inhalte werden teils per innerHTML neu aufgebaut (Favoriten, ORBAT,
  // Ebenen) — dabei geht die Leiste verloren. Wieder einsetzen, sobald das passiert.
  const ensureBar = () => {
    if (el.firstChild !== bar) {
      el.prepend(bar);
      applyPin();
    }
    if (resizeHandle && !el.contains(resizeHandle)) el.appendChild(resizeHandle);
  };
  new MutationObserver(ensureBar).observe(el, { childList: true });

  if (resizeHandle) {
    const applySize = () => {
      try {
        const s = JSON.parse(rd(sizeKey) || "null");
        if (s && typeof s.w === "number" && typeof s.h === "number") {
          el.style.width = `${s.w}px`;
          el.style.height = `${s.h}px`;
          el.style.maxWidth = "none";
          el.style.maxHeight = "none";
        }
      } catch {
        /* ignore */
      }
    };
    applySize();
    resizeHandle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = el.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = r.width;
      const startH = r.height;
      const onMove = (ev: MouseEvent) => {
        const w = Math.max(220, startW + (ev.clientX - startX));
        const h = Math.max(140, startH + (ev.clientY - startY));
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;
        el.style.maxWidth = "none";
        el.style.maxHeight = "none";
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        try {
          uiSet(sizeKey, JSON.stringify({ w: el.offsetWidth, h: el.offsetHeight }));
        } catch {
          /* ignore */
        }
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  const readPin = () => {
    try {
      return rd(pinKey) === "1";
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

  const topGuard = () => {
    const v = parseInt(getComputedStyle(el).getPropertyValue("--topbar-h"));
    return (Number.isFinite(v) ? v : 48) + 6; // Panels bleiben unter der Topbar
  };
  const clampX = (x: number) => Math.max(4, Math.min(window.innerWidth - KEEP_X, x));
  const clampY = (y: number) => Math.max(topGuard(), Math.min(window.innerHeight - KEEP_Y, y));
  const savePos = (x: number, y: number) => {
    try {
      uiSet(posKey, JSON.stringify({ x: Math.round(x), y: Math.round(y) }));
    } catch {
      /* ignore */
    }
  };
  // Ragt das Panel unten aus dem Fenster, wird es auf den freien Platz begrenzt und scrollbar.
  // Passt es komplett hinein, bleibt es unverändert (Höhe = Inhalt bzw. gespeicherte Größe).
  // Mobil sitzen die Panels als Blatt unten (CSS), dort gilt die CSS-Grenze.
  const fit = () => {
    if (!el.isConnected || el.hidden) return;
    const set = (mh: string, oy: string) => {
      if (el.style.maxHeight !== mh) el.style.maxHeight = mh;
      if (el.style.overflowY !== oy) el.style.overflowY = oy;
    };
    const sized = !!resizeHandle && !!el.style.height;
    const free = sized ? "none" : "";
    if (window.matchMedia("(max-width: 760px)").matches || !el.style.top) return set(free, "");
    const top = el.getBoundingClientRect().top;
    const avail = Math.max(120, window.innerHeight - top - 8);
    const natural = el.scrollHeight + (el.offsetHeight - el.clientHeight);
    if (natural > avail + 1) set(`${avail}px`, "auto");
    else set(free, "");
  };
  new ResizeObserver(fit).observe(el);
  window.addEventListener("resize", fit);

  const place = (x: number, y: number, persist = false) => {
    const cx = clampX(x);
    const cy = clampY(y);
    el.style.left = `${cx}px`;
    el.style.top = `${cy}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
    fit();
    if (persist) {
      delete el.dataset.mvOrigLeft;
      savePos(cx, cy);
    }
  };

  const applyPos = () => {
    try {
      const p = JSON.parse(rd(posKey) || "null");
      if (p && typeof p.x === "number") place(p.x, p.y);
    } catch {
      /* ignore */
    }
  };
  applyPos();

  // Rechte Bilder-Leiste offen: verschobene Fenster weichen nach links aus (nur Anzeige, gespeicherte Position bleibt)
  const avoidRail = () => {
    if (!el.isConnected || el.hidden || !el.style.left) return;
    const rail = document.querySelector<HTMLElement>(".img-rail.open");
    const rw = rail ? rail.offsetWidth : 0;
    const r = el.getBoundingClientRect();
    if (rw && r.right > window.innerWidth - rw - 6) {
      if (el.dataset.mvOrigLeft === undefined) el.dataset.mvOrigLeft = el.style.left;
      el.style.left = `${Math.max(4, window.innerWidth - rw - 6 - r.width)}px`;
    } else if (el.dataset.mvOrigLeft !== undefined) {
      const orig = parseInt(el.dataset.mvOrigLeft);
      // zurück an den alten Platz, solange er die offene Leiste nicht berührt
      if (!rw || orig + r.width <= window.innerWidth - rw - 6) {
        el.style.left = el.dataset.mvOrigLeft;
        delete el.dataset.mvOrigLeft;
      }
    }
  };
  document.addEventListener("sidc-rail", avoidRail);
  window.addEventListener("resize", avoidRail);
  setTimeout(avoidRail, 0);

  bar.querySelector(".mv-pin")?.addEventListener("click", (e) => {
    e.stopPropagation();
    pinned = !pinned;
    try {
      uiSet(pinKey, pinned ? "1" : "0");
    } catch {
      /* ignore */
    }
    applyPin();
  });

  bar.querySelector(".mv-x")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (pinned) {
      pinned = false;
      try {
        uiSet(pinKey, "0");
      } catch {
        /* ignore */
      }
      applyPin();
    }
    el.hidden = true;
    opts.onClose?.();
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
      fit();
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
      for (const k of [posKey, ...(resizeHandle ? [sizeKey] : [])]) {
        uiRemove(k);
        uiRemove(legacy(k));
      }
    } catch {
      /* ignore */
    }
    el.style.left = el.style.top = "";
    el.style.right = el.style.bottom = "";
    if (resizeHandle) {
      el.style.width = el.style.height = "";
      el.style.maxWidth = el.style.maxHeight = "";
    }
    el.style.maxHeight = "";
    el.style.overflowY = "";
  };

  return {
    isPinned: () => pinned,
    hasPos: () => {
      try {
        return !!rd(posKey);
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
      else place(el.dataset.mvOrigLeft !== undefined ? parseInt(el.dataset.mvOrigLeft) : r.left, r.top, true);
      avoidRail();
    },
  };
}
