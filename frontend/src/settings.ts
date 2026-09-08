// Einstellungs-Menü (pro Browser, localStorage). Aktuell: Theme + Tastenkürzel
// für die Karten-Werkzeuge.
import { t } from "./i18n";
import { icon } from "./icons";
import { themeSwitch, wireThemeSwitch } from "./ui";

export type ModeKey =
  | "move"
  | "markermove"
  | "point"
  | "line"
  | "measure"
  | "erase"
  | "place";

export const MODE_ORDER: ModeKey[] = [
  "move",
  "markermove",
  "point",
  "line",
  "measure",
  "erase",
  "place",
];

const DEFAULTS: Record<ModeKey, string> = {
  move: "v",
  markermove: "m",
  point: "q",
  line: "l",
  measure: "r",
  erase: "e",
  place: "p",
};

const KEY = "sidc_keybinds";

export function getKeybinds(): Record<ModeKey, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(binds: Record<ModeKey, string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(binds));
  } catch {
    /* ignore */
  }
}

export function modeForKey(ev: KeyboardEvent): ModeKey | null {
  const el = ev.target as HTMLElement | null;
  if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return null;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return null;
  const k = ev.key.toLowerCase();
  const binds = getKeybinds();
  for (const m of MODE_ORDER) if (binds[m] === k) return m;
  return null;
}

export function openSettings(): void {
  const back = document.createElement("div");
  back.className = "edit-modal";
  const binds = getKeybinds();

  const LABEL: Record<ModeKey, string> = {
    move: t("tool.move"),
    markermove: t("tool.markermove"),
    point: t("tool.point"),
    line: t("tool.line"),
    measure: t("tool.measure"),
    erase: t("tool.erase"),
    place: t("tool.marker"),
  };
  const rows = () =>
    MODE_ORDER.map(
      (m) => `<div class="set-row">
        <span>${LABEL[m]}</span>
        <button class="kb-key" data-kb="${m}">${binds[m] ? binds[m].toUpperCase() : "—"}</button>
      </div>`,
    ).join("");

  back.innerHTML = `<div class="card set-card">
    <div class="row"><h1 style="flex:1">${icon("settings")} ${t("settings.title")}</h1>
      <button class="icon-btn" data-x>${icon("x")}</button></div>
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
  const onEsc = (e: KeyboardEvent) => {
    if (capturing) return;
    if (e.key === "Escape") close();
  };
  let capturing: string | null = null;

  back.addEventListener("mousedown", (e) => {
    if (e.target === back && !capturing) close();
  });
  back.querySelector("[data-x]")!.addEventListener("click", close);
  wireThemeSwitch(back);

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
          if (e.key === "Escape") {
            b.textContent = (binds[b.dataset.kb as ModeKey] || "—").toUpperCase();
            return;
          }
          const k = e.key.toLowerCase();
          // Kollision auflösen: gleiche Taste woanders freigeben
          for (const m of MODE_ORDER) if (binds[m] === k) binds[m] = "";
          binds[b.dataset.kb as ModeKey] = k.length === 1 ? k : "";
          save(binds);
          back.querySelector("#kbRows")!.innerHTML = rows();
          wireKb();
        };
        document.addEventListener("keydown", grab, true);
      }),
    );
  };
  wireKb();

  back.querySelector("[data-reset]")!.addEventListener("click", () => {
    save({ ...DEFAULTS });
    Object.assign(binds, DEFAULTS);
    back.querySelector("#kbRows")!.innerHTML = rows();
    wireKb();
  });

  document.addEventListener("keydown", onEsc, true);
  document.body.appendChild(back);
}
