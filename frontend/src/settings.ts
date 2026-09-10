// Einstellungs-Menü: Theme + Tastenkürzel. Keybinds werden PRO NUTZER auf dem
// Server gespeichert (me.ui_settings.keybinds); localStorage dient nur als Cache.
import { api, type Me } from "./api";
import { t } from "./i18n";
import { icon } from "./icons";
import { themeSwitch, wireThemeSwitch } from "./ui";
import { toast, toastError } from "./notify";
import { esc } from "./esc";

export type HotAction =
  | "undo"
  | "redo"
  | "mapMove"
  | "point"
  | "line"
  | "markermove"
  | "measure"
  | "text"
  | "fav"
  | "place"
  | "channelUp"
  | "channelDown"
  | "phasePrev"
  | "phaseNext"
  | "notes"
  | "cut"
  | "copy"
  | "paste"
  | "north";

export const HOT_ORDER: HotAction[] = [
  "mapMove",
  "point",
  "line",
  "markermove",
  "measure",
  "text",
  "fav",
  "place",
  "undo",
  "redo",
  "cut",
  "copy",
  "paste",
  "channelUp",
  "channelDown",
  "phasePrev",
  "phaseNext",
  "notes",
  "north",
];

const DEFAULTS: Record<HotAction, string> = {
  mapMove: "w",
  point: "a",
  line: "d",
  markermove: "s",
  measure: "r",
  text: "t",
  fav: "f",
  place: " ",
  undo: "q",
  redo: "e",
  cut: "x",
  copy: "c",
  paste: "v",
  channelUp: "arrowup",
  channelDown: "arrowdown",
  phasePrev: "arrowleft",
  phaseNext: "arrowright",
  notes: "y",
  north: "n",
};

const ALLOWED_SPECIAL = [" ", "arrowup", "arrowdown", "arrowleft", "arrowright"];
const CACHE_KEY = "sidc_keybinds";

let binds: Record<HotAction, string> = { ...DEFAULTS };
let currentMe: Me | null = null;

function normalizeStored(raw: unknown): Record<HotAction, string> {
  const out = { ...DEFAULTS };
  if (raw && typeof raw === "object") {
    for (const a of HOT_ORDER) {
      const v = (raw as Record<string, unknown>)[a];
      if (typeof v === "string") out[a] = v;
    }
  }
  return out;
}

export function initSettings(me: Me): void {
  currentMe = me;
  const fromServer = (me.ui_settings as Record<string, unknown> | undefined)?.keybinds;
  if (fromServer) {
    binds = normalizeStored(fromServer);
  } else {
    try {
      binds = normalizeStored(JSON.parse(localStorage.getItem(CACHE_KEY) || "null"));
    } catch {
      binds = { ...DEFAULTS };
    }
  }
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(binds));
  } catch {
    /* ignore */
  }
}

export function getKeybinds(): Record<HotAction, string> {
  return binds;
}

function persist(): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(binds));
  } catch {
    /* ignore */
  }
  void api.saveSettings({ keybinds: binds }).catch(() => {});
}

export function keyLabel(k: string): string {
  if (!k) return "—";
  return (
    {
      " ": "Space",
      arrowup: "↑",
      arrowdown: "↓",
      arrowleft: "←",
      arrowright: "→",
    }[k] ?? k.toUpperCase()
  );
}

export function actionForKey(ev: KeyboardEvent): HotAction | null {
  const el = ev.target as HTMLElement | null;
  if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return null;
  if (el && el.isContentEditable) return null;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return null;
  const k = ev.key === " " ? " " : ev.key.toLowerCase();
  for (const a of HOT_ORDER) if (binds[a] === k) return a;
  return null;
}

export function openSettings(): void {
  const back = document.createElement("div");
  back.className = "edit-modal";

  const LABEL: Record<HotAction, string> = {
    mapMove: t("tool.move"),
    point: t("tool.point"),
    line: t("tool.line"),
    markermove: t("tool.markermove"),
    measure: t("tool.measure"),
    text: t("tool.text"),
    fav: t("tool.fav"),
    place: t("tool.marker"),
    undo: t("edit.undo"),
    redo: t("edit.redo"),
    cut: t("hot.cut"),
    copy: t("hot.copy"),
    paste: t("hot.paste"),
    channelUp: t("hot.channelUp"),
    channelDown: t("hot.channelDown"),
    phasePrev: t("hot.phasePrev"),
    phaseNext: t("hot.phaseNext"),
    notes: t("hot.notes"),
    north: t("hot.north"),
  };
  const rows = () =>
    HOT_ORDER.map(
      (a) => `<div class="set-row">
        <span>${LABEL[a]}</span>
        <button class="kb-key" data-kb="${a}">${keyLabel(binds[a])}</button>
      </div>`,
    ).join("");

  back.innerHTML = `<div class="card set-card">
    <div class="row"><h1 style="flex:1">${icon("settings")} ${t("settings.title")}</h1>
      <button class="icon-btn" data-x>${icon("x")}</button></div>
    <h4>${t("settings.displayName")}</h4>
    <input id="set-dname" maxlength="64" value="${esc(currentMe?.display_name ?? "")}"
      placeholder="${esc(currentMe?.username ?? "")}" style="width:100%" />
    <p class="muted" style="font-size:.78rem;margin:.2rem 0 0">${t("settings.displayNameHint")}</p>
    <h4>${t("theme.label")}</h4>
    ${themeSwitch()}
    <h4>${t("settings.keybinds")}</h4>
    <p class="muted">${t("settings.keybindsHint")}</p>
    <div id="kbRows">${rows()}</div>
    <div class="row" style="margin-top:.8rem">
      <button data-reset>${t("settings.reset")}</button>
    </div>
  </div>`;

  const close = () => {
    back.remove();
    document.removeEventListener("keydown", onEsc, true);
  };
  let capturing: string | null = null;
  const onEsc = (e: KeyboardEvent) => {
    if (capturing) return;
    if (e.key === "Escape") close();
  };

  back.addEventListener("mousedown", (e) => {
    if (e.target === back && !capturing) close();
  });
  back.querySelector("[data-x]")!.addEventListener("click", close);
  wireThemeSwitch(back);

  const dn = back.querySelector<HTMLInputElement>("#set-dname")!;
  dn.addEventListener("change", async () => {
    const v = dn.value.trim();
    if (v === (currentMe?.display_name ?? "")) return;
    try {
      const me = await api.saveDisplayName(v);
      if (currentMe) currentMe.display_name = me.display_name;
      toast(t("settings.displayName") + " ✓", { kind: "success" });
    } catch (e) {
      toastError(e);
    }
  });

  const wireKb = () => {
    back.querySelectorAll<HTMLButtonElement>("[data-kb]").forEach((b) =>
      b.addEventListener("click", () => {
        capturing = b.dataset.kb!;
        b.textContent = "…";
        const grab = (e: KeyboardEvent) => {
          e.preventDefault();
          e.stopPropagation();
          document.removeEventListener("keydown", grab, true);
          capturing = null;
          const a = b.dataset.kb as HotAction;
          if (e.key === "Escape") {
            b.textContent = keyLabel(binds[a]);
            return;
          }
          const k = e.key === " " ? " " : e.key.toLowerCase();
          const ok = k.length === 1 || ALLOWED_SPECIAL.includes(k);
          if (!ok) {
            b.textContent = keyLabel(binds[a]);
            return;
          }
          for (const x of HOT_ORDER) if (binds[x] === k) binds[x] = ""; // Kollision lösen
          binds[a] = k;
          persist();
          back.querySelector("#kbRows")!.innerHTML = rows();
          wireKb();
        };
        document.addEventListener("keydown", grab, true);
      }),
    );
  };
  wireKb();

  back.querySelector("[data-reset]")!.addEventListener("click", () => {
    binds = { ...DEFAULTS };
    persist();
    back.querySelector("#kbRows")!.innerHTML = rows();
    wireKb();
  });

  document.addEventListener("keydown", onEsc, true);
  document.body.appendChild(back);
}
