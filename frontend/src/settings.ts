// Einstellungs-Menü: Theme + Tastenkürzel. Keybinds werden PRO NUTZER auf dem
// Server gespeichert (me.ui_settings.keybinds); localStorage dient nur als Cache.
import { api, type Me } from "./api";
import { t } from "./i18n";
import { icon } from "./icons";
import { themeSwitch, wireThemeSwitch } from "./ui";
import { confirmDialog, promptDialog, toast, toastError } from "./notify";
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
    <h4>${t("tok.title")}</h4>
    <p class="muted" style="font-size:.78rem;margin:.2rem 0">${t("tok.hint")}</p>
    <div id="tokBox"></div>
    <div class="row" style="gap:.4rem;margin-top:.4rem">
      <input id="tok-name" maxlength="64" placeholder="${esc(t("tok.name"))}" style="flex:1" />
      <select id="tok-days">
        <option value="">${t("tok.never")}</option>
        <option value="30">30 ${t("tok.days")}</option>
        <option value="90">90 ${t("tok.days")}</option>
        <option value="365">365 ${t("tok.days")}</option>
      </select>
      <button id="tok-create">${t("tok.create")}</button>
    </div>
    <h4>${t("settings.myData")}</h4>
    <div class="row" style="gap:.5rem">
      <button data-export>${icon("download", 16)} ${t("settings.exportData")}</button>
      <button class="danger" data-delacc>${t("settings.deleteAccount")}</button>
    </div>
    <div class="row" style="margin-top:.6rem;gap:.8rem">
      <a href="#/impressum">${t("legal.imprint")}</a>
      <a href="#/datenschutz">${t("legal.privacy")}</a>
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
  back.querySelectorAll<HTMLAnchorElement>('a[href^="#/"]').forEach((a) => a.addEventListener("click", close));
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

  back.querySelector("[data-export]")!.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    try {
      const { blob, filename } = await api.exportMyData();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toastError(err);
    } finally {
      btn.disabled = false;
    }
  });

  back.querySelector("[data-delacc]")!.addEventListener("click", async () => {
    if (!(await confirmDialog(t("settings.deleteAccountConfirm"), { danger: true, okLabel: t("settings.deleteAccount") })))
      return;
    const typed = await promptDialog(
      t("settings.deleteAccountTypeName").replace("{name}", currentMe?.username ?? ""),
      { okLabel: t("settings.deleteAccount") },
    );
    if (typed !== currentMe?.username) {
      if (typed !== null) toastError(new Error(t("settings.deleteAccountMismatch")));
      return;
    }
    try {
      await api.deleteMyAccount();
      location.hash = "#/";
      location.reload();
    } catch (err) {
      toastError(err);
    }
  });

  wireTokens(back);

  document.addEventListener("keydown", onEsc, true);
  document.body.appendChild(back);
}

function wireTokens(root: HTMLElement): void {
  const box = root.querySelector<HTMLElement>("#tokBox")!;
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : null);

  const render = async (fresh?: string) => {
    let items;
    try {
      items = await api.apiTokens();
    } catch (e) {
      toastError(e);
      return;
    }
    const rows = items
      .map(
        (tk) => `<div class="set-row" data-tok="${tk.id}">
          <span><strong>${esc(tk.name)}</strong> <code>${esc(tk.prefix)}…</code>
            <span class="muted" style="font-size:.78rem">
              ${tk.revoked ? t("tok.revoked") : `${t("tok.lastUsed")}: ${fmt(tk.last_used_at) ?? t("tok.neverUsed")}`}
              ${tk.expires_at ? ` · ${t("tok.expires")}: ${fmt(tk.expires_at)}` : ""}
            </span></span>
          ${tk.revoked ? "" : `<button class="danger" data-revoke="${tk.id}">${t("tok.revoke")}</button>`}
        </div>`,
      )
      .join("");
    box.innerHTML =
      (fresh
        ? `<div class="card" style="padding:.5rem;margin:.3rem 0">
            <div style="font-size:.82rem">${t("tok.created")}</div>
            <div class="row" style="gap:.4rem"><code style="flex:1;word-break:break-all;user-select:all">${esc(fresh)}</code>
              <button data-tokcopy>${t("tok.copy")}</button></div>
          </div>`
        : "") + (rows || `<p class="muted">${t("tok.none")}</p>`);

    box.querySelector<HTMLButtonElement>("[data-tokcopy]")?.addEventListener("click", async (e) => {
      try {
        await navigator.clipboard.writeText(fresh!);
        (e.currentTarget as HTMLButtonElement).textContent = t("tok.copied");
      } catch {
        /* Clipboard nicht verfügbar — Token ist markierbar */
      }
    });
    box.querySelectorAll<HTMLButtonElement>("[data-revoke]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!(await confirmDialog(t("tok.revokeConfirm"), { danger: true, okLabel: t("tok.revoke") }))) return;
        try {
          await api.revokeApiToken(b.dataset.revoke!);
          void render();
        } catch (e) {
          toastError(e);
        }
      }),
    );
  };

  root.querySelector<HTMLButtonElement>("#tok-create")!.addEventListener("click", async () => {
    const name = root.querySelector<HTMLInputElement>("#tok-name")!;
    const days = root.querySelector<HTMLSelectElement>("#tok-days")!;
    if (!name.value.trim()) return;
    try {
      const created = await api.createApiToken(name.value.trim(), days.value ? Number(days.value) : null);
      name.value = "";
      await render(created.token);
    } catch (e) {
      toastError(e);
    }
  });

  void render();
}
