// Verknüpfungs-Codes ({{doc:…}}, {{task:…}}, {{plan:…}}, {{note:…}}, {{img:…}}, {{place:<karte>:<name>}}):
// ALLE Backend-Aufrufe dafür (resolve, backlinks, search, timeline) sowie Chips, „Code kopieren" und Deep-Links.
// Weicht die Backend-Antwort in Details ab, genügt eine Anpassung in dieser Datei.
import { req, type ProjectSpace } from "./api";
import { esc } from "./esc";
import { icon } from "./icons";
import { t } from "./i18n";
import { REF_ICON } from "./md";
import { promptDialog, toast } from "./notify";

export type RefType = "doc" | "task" | "plan" | "note" | "img" | "place";

/** Ein aufgelöstes Ziel (resolve / backlinks / search). `ok:false` = fehlt oder nicht erlaubt. */
export interface RefInfo {
  type: string;
  id: string;
  label: string;
  sub?: string;
  href?: string;
  ok?: boolean;
  snippet?: string;
}

export interface TimelineEntry {
  doc_id: string;
  doc_name: string;
  space: ProjectSpace;
  heading: string;
  /** Tag (1 = Missionsbeginn-Tag); bei relativen Einträgen leer */
  day?: number | null;
  /** Minuten ab 00:00 des Tages bzw. ab Missionsbeginn (relativ) */
  minutes?: number | null;
  relative?: boolean;
  href?: string;
}

// ─── API ──────────────────────────────────────────────────────────────────

/** Antwort als Liste lesen – auch wenn das Backend sie in `{items:[…]}` einpackt. */
function asList<T>(r: unknown): T[] {
  if (Array.isArray(r)) return r as T[];
  const items = (r as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}

const enc = encodeURIComponent;

export const refApi = {
  resolve: async (pid: string, refs: { type: string; id: string }[]): Promise<RefInfo[]> =>
    asList<RefInfo>(await req<unknown>("POST", `/projects/${pid}/refs/resolve`, { refs })),
  backlinks: async (pid: string, type: string, id: string): Promise<RefInfo[]> =>
    asList<RefInfo>(await req<unknown>("GET", `/projects/${pid}/refs/backlinks?type=${enc(type)}&id=${enc(id)}`)),
  search: async (pid: string, q: string, o: { types?: string[]; space?: string; limit?: number } = {}): Promise<RefInfo[]> => {
    const p = new URLSearchParams({ q });
    if (o.types?.length) p.set("types", o.types.join(","));
    if (o.space) p.set("space", o.space);
    p.set("limit", String(o.limit ?? 30));
    return asList<RefInfo>(await req<unknown>("GET", `/projects/${pid}/search?${p}`));
  },
  timeline: async (pid: string): Promise<TimelineEntry[]> => asList<TimelineEntry>(await req<unknown>("GET", `/projects/${pid}/timeline`)),
};

// ─── Hilfen ───────────────────────────────────────────────────────────────

export const codeOf = (type: string, id: string): string => `{{${type}:${id}}}`;

/** Nur interne Hash-Links akzeptieren (kein javascript:, keine fremden Adressen). */
export function safeHref(h: string | null | undefined): string {
  return h && /^#\/[A-Za-z0-9/_\-?=&%.~:+]*$/.test(h) ? h : "";
}

/** Ortsnamen für {{place:…}} säubern (keine Klammern/Zeilenumbrüche). */
export const cleanPlaceName = (n: string): string => n.replace(/[{}\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);

const PROJ_HASH = /^#\/projects\/([0-9a-f]{32})(?:\/([a-z]+))?(?:\?(.*))?$/;

/**
 * Hash-Link öffnen. Zeigt er auf einen Deep-Link (?doc=…) im selben Projekt, bekommt zuerst der geöffnete Tab
 * ein `proj-deeplink`-Ereignis (cancelable) – so geht ein ungespeicherter Entwurf nicht durch ein Neuladen verloren.
 */
export function openHref(href: string, pid: string): void {
  const h = safeHref(href);
  if (!h) return;
  const m = h.match(PROJ_HASH);
  if (m && m[1] === pid && m[3]) {
    const ev = new CustomEvent("proj-deeplink", { cancelable: true, detail: { pid, tab: m[2] ?? "", params: new URLSearchParams(m[3]) } });
    if (!window.dispatchEvent(ev)) return; // ein Tab hat es selbst behandelt
  }
  location.hash = h;
}

/** Deep-Link-Parameter (?doc=, ?task=, ?note=, ?img=) beim Mounten lesen und aus der Adresszeile entfernen. */
export function takeDeepLink(): URLSearchParams {
  const h = location.hash;
  const i = h.indexOf("?");
  if (i < 0) return new URLSearchParams();
  const p = new URLSearchParams(h.slice(i + 1));
  try {
    history.replaceState(null, "", location.pathname + location.search + h.slice(0, i));
  } catch {
    /* ignorieren */
  }
  return p;
}

/** Tab-Handler für `proj-deeplink` anmelden (räumt sich auf, sobald `host` nicht mehr im DOM hängt). */
export function onDeepLink(host: HTMLElement, pid: string, tabs: string[], fn: (p: URLSearchParams) => boolean): void {
  const h = (e: Event) => {
    if (!host.isConnected) return window.removeEventListener("proj-deeplink", h);
    const d = (e as CustomEvent<{ pid: string; tab: string; params: URLSearchParams }>).detail;
    if (d.pid === pid && tabs.includes(d.tab) && fn(d.params)) e.preventDefault();
  };
  window.addEventListener("proj-deeplink", h);
}

export function projectLink(pid: string, tab: string, q = ""): string {
  return `#/projects/${pid}/${tab}${q ? "?" + q : ""}`;
}

// ─── Code kopieren ────────────────────────────────────────────────────────

export async function copyCode(code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(code);
    toast(t("ref.copied"), { kind: "success", timeout: 2200 });
    return;
  } catch {
    /* kein Clipboard-API (z. B. http) → Fallback */
  }
  const ta = document.createElement("textarea");
  ta.value = code;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;opacity:0;left:-9999px";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  if (ok) toast(t("ref.copied"), { kind: "success", timeout: 2200 });
  else await promptDialog(t("ref.copyManual"), { value: code });
}

/** Knopf „Code kopieren"; per wireCopyButtons() auf dem Container aktiv. */
export function copyBtn(type: RefType, id: string, cls = "icon-btn", size = 14): string {
  const lbl = t("ref.copyCode");
  return `<button type="button" class="${cls} ref-copy" data-ref-copy="${esc(codeOf(type, id))}" title="${lbl}" aria-label="${lbl}">${icon("link", size)}</button>`;
}

/** Klicks auf [data-ref-copy] im Container (Capture-Phase: eigene Zeilen-/Karten-Klicks laufen nicht mit). */
export function wireCopyButtons(root: HTMLElement): void {
  if (root.dataset.copyWired) return;
  root.dataset.copyWired = "1";
  root.addEventListener(
    "click",
    (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-ref-copy]");
      if (!b || !root.contains(b)) return;
      e.preventDefault();
      e.stopPropagation();
      void copyCode(b.dataset.refCopy ?? "");
    },
    true,
  );
}

// ─── Chips auflösen ───────────────────────────────────────────────────────

interface Cached {
  at: number;
  info: RefInfo | null;
}
const CACHE_MS = 30000;
const cache = new Map<string, Cached>();
const keyOf = (pid: string, type: string, id: string) => `${pid}|${type}|${id}`;

/** Aufgelöste Namen verwerfen (nach Umbenennen/Speichern). */
export function clearRefCache(): void {
  cache.clear();
}

const chipInfo = new WeakMap<HTMLElement, RefInfo | null>();

function chipRef(el: HTMLElement): { type: string; id: string } {
  return el.classList.contains("note-img-ref") ? { type: "img", id: el.dataset.img ?? "" } : { type: el.dataset.refType ?? "", id: el.dataset.refId ?? "" };
}

/**
 * Chips ({{…}}-Codes) im gerenderten Markdown füllen: ein gebündelter `refs/resolve`-Aufruf je Render
 * (Ergebnisse 30 s im Cache). Unbekannte/nicht erlaubte Ziele werden zu grauen „nicht verfügbar"-Chips.
 */
export async function wireRefChips(root: HTMLElement, pid: string): Promise<void> {
  const chips = [...root.querySelectorAll<HTMLElement>(".ref-chip, .note-img-ref")];
  if (!chips.length) return;
  const now = Date.now();
  const need = new Map<string, { type: string; id: string }>();
  for (const el of chips) {
    const r = chipRef(el);
    if (!r.type || !r.id) continue;
    const k = keyOf(pid, r.type, r.id);
    const c = cache.get(k);
    if (!c || now - c.at > CACHE_MS) need.set(k, r);
  }
  if (need.size) {
    const list = [...need.values()];
    for (let i = 0; i < list.length; i += 200) {
      const part = list.slice(i, i + 200);
      try {
        const res = await refApi.resolve(pid, part);
        const byKey = new Map(res.map((x) => [`${x.type}|${x.id}`, x]));
        part.forEach((r, j) => {
          const info = byKey.get(`${r.type}|${r.id}`) ?? (res.length === part.length ? res[j] : undefined);
          cache.set(keyOf(pid, r.type, r.id), { at: Date.now(), info: info ?? { ...r, label: "", ok: false } });
        });
      } catch {
        /* Netzfehler: diese Chips bleiben im neutralen Zustand */
      }
    }
  }
  for (const el of chips) {
    if (!el.isConnected) continue;
    const r = chipRef(el);
    const c = cache.get(keyOf(pid, r.type, r.id));
    if (c) applyChip(el, c.info, pid);
  }
}

function applyChip(el: HTMLElement, info: RefInfo | null, pid: string): void {
  const first = !chipInfo.has(el);
  chipInfo.set(el, info);
  const r = chipRef(el);
  const isImg = el.classList.contains("note-img-ref");
  el.classList.remove("ref-missing");
  el.removeAttribute("aria-disabled");
  const lbl = (txt: string) => {
    if (isImg) {
      el.innerHTML = `${icon("image", 12)}<span class="ref-lbl"></span>`;
      el.classList.add("ref-chip", "ref-img");
    }
    const s = el.querySelector<HTMLElement>(".ref-lbl");
    if (s) s.textContent = txt;
  };
  if (!info || info.ok === false) {
    el.classList.add("ref-missing");
    el.setAttribute("aria-disabled", "true");
    el.removeAttribute("href");
    el.removeAttribute("role");
    el.removeAttribute("tabindex");
    el.title = t("ref.unavailableHint");
    lbl(t("ref.unavailable"));
  } else {
    lbl(info.label || t("ref.type." + r.type));
    el.title = [t("ref.type." + r.type), info.sub].filter(Boolean).join(" · ");
    const href = r.type === "place" ? "" : safeHref(info.href);
    if (href) {
      el.setAttribute("href", href);
      el.removeAttribute("role");
    } else {
      el.removeAttribute("href");
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
    }
  }
  if (!first) return;
  const go = (e: Event) => {
    const cur = chipInfo.get(el);
    if (!cur || cur.ok === false) return e.preventDefault();
    if (r.type === "place") {
      e.preventDefault();
      showPlacePopover(el, cur);
      return;
    }
    const href = safeHref(cur.href);
    if (!href) return e.preventDefault();
    const me = e as MouseEvent;
    if (me.ctrlKey || me.metaKey || me.shiftKey || me.button) return; // neuer Tab etc.: Browser entscheiden lassen
    e.preventDefault();
    openHref(href, pid);
  };
  el.addEventListener("click", go);
  el.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && !el.hasAttribute("href")) {
      e.preventDefault();
      go(e);
    }
  });
}

// ─── Ort-Chip: kleines Info-Popover ───────────────────────────────────────

let pop: HTMLElement | null = null;
function closePop(): void {
  pop?.remove();
  pop = null;
  document.removeEventListener("mousedown", onPopOutside, true);
  document.removeEventListener("keydown", onPopKey, true);
}
const onPopOutside = (e: MouseEvent) => {
  if (pop && !pop.contains(e.target as Node)) closePop();
};
const onPopKey = (e: KeyboardEvent) => {
  if (e.key === "Escape") closePop();
};

function showPlacePopover(anchor: HTMLElement, info: RefInfo): void {
  closePop();
  const href = safeHref(info.href);
  pop = document.createElement("div");
  pop.className = "ref-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", info.label);
  pop.innerHTML = `<strong>${icon("marker", 14)} <span class="rp-p-name"></span></strong>
    <span class="muted rp-p-map"></span>
    ${href ? `<a class="rp-p-open" href="${esc(href)}">${t("ref.openMap")}</a>` : ""}`;
  pop.querySelector(".rp-p-name")!.textContent = info.label;
  const mapEl = pop.querySelector<HTMLElement>(".rp-p-map")!;
  mapEl.textContent = info.sub ? `${t("ref.map")}: ${info.sub}` : "";
  mapEl.hidden = !info.sub;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left))}px`;
  pop.style.top = `${Math.min(window.innerHeight - pop.offsetHeight - 8, r.bottom + 6)}px`;
  document.addEventListener("mousedown", onPopOutside, true);
  document.addEventListener("keydown", onPopKey, true);
  pop.querySelector<HTMLElement>("a")?.focus();
}

// ─── Rückverweise („Erwähnt in …") ────────────────────────────────────────

export async function mountBacklinks(box: HTMLElement, pid: string, type: RefType, id: string): Promise<void> {
  box.classList.add("ref-bl");
  box.innerHTML = `<h4 class="ref-bl-title">${icon("link", 14)} ${t("ref.backlinks")}</h4><div class="ref-bl-body muted">${t("common.loading")}</div>`;
  const body = box.querySelector<HTMLElement>(".ref-bl-body")!;
  let list: RefInfo[] = [];
  try {
    list = await refApi.backlinks(pid, type, id);
  } catch {
    body.textContent = t("ref.backlinksFail");
    return;
  }
  if (!box.isConnected) return;
  if (!list.length) {
    body.textContent = t("ref.backlinksNone");
    return;
  }
  body.classList.remove("muted");
  body.innerHTML = `<ul class="ref-bl-list">${list
    .map((x) => {
      const href = safeHref(x.href);
      const inner = `${icon(REF_ICON[x.type] ?? "help", 13)}<span>${esc(x.label || t("ref.unavailable"))}</span><small class="muted">${esc(t("ref.type." + x.type))}</small>`;
      return `<li>${href ? `<a href="${esc(href)}">${inner}</a>` : `<span class="ref-bl-nolink">${inner}</span>`}</li>`;
    })
    .join("")}</ul>`;
  body.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
    const me = e as MouseEvent;
    if (!a || me.ctrlKey || me.metaKey || me.shiftKey || me.button) return;
    e.preventDefault();
    openHref(a.getAttribute("href") ?? "", pid);
  });
}
