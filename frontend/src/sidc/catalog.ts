// Lädt die vom Admin hochgeladenen SIDC-Kataloge (Format 1:1 wie ingame LocalMapData).

export interface CatalogEntry {
  name: string;
  sidc: string;
  languageKey: string;
  subCategory?: string; // Schlüssel in den Modifier-Katalog (z. B. "Land_Unit")
  isMultiPointLine?: boolean;
  maxLinePoints?: number;
  defaultTimestampVisible?: boolean;
  defaultLocked?: boolean;
}

export interface ModifierOption {
  code: number;
  description: string;
  languageKey: string;
}
/** SIDC_ModifierCatalog.json: { "<subCategory>": { modifier1: [...], ... modifier5: [...] } } */
export type ModifierCatalog = Record<string, Record<string, ModifierOption[]>>;
export interface CatalogCategory {
  key: string;
  label: string;
  entries: CatalogEntry[];
}

export interface QuickMenuButton {
  buttonLanguageKey: string;
  isGroup: boolean;
  showSearch: boolean;
  markerSubCategory: string;
  markerDescription: string;
  needsAmp: boolean;
  needsDirection: boolean;
  placeOnClick: boolean;
  nestedRows: QuickMenuRow[];
}
export interface QuickMenuRow {
  verticalLayout: boolean;
  buttons: QuickMenuButton[];
}
export interface QuickMenuSubCategory {
  subCategoryName: string;
  buttonLanguageKey: string;
  rows: QuickMenuRow[];
}
export interface QuickMenuCategory {
  categoryName: string;
  buttonLanguageKey: string;
  setsIdentity: boolean;
  identity: string;
  subCategories: QuickMenuSubCategory[];
}
export interface QuickMenuCatalog {
  categoryRows: { verticalLayout: boolean; categories: QuickMenuCategory[] }[];
}

export interface ChannelEntry {
  name: string;
  languageKey: string;
}
export interface ChannelSettings {
  currentChannel: string;
  channels: ChannelEntry[];
  physicalChannels: { name: string; languageKey: string }[];
}

export interface PhaseLineColor {
  name: string;
  red: number;
  green: number;
  blue: number;
  packedColor: number;
  isDefault: boolean;
}
export interface PhaseLineStyle {
  colors: PhaseLineColor[];
  widths: { width: number; isDefault: boolean }[];
  fallback: { lineColor: number; lineWidth: number };
}

const CATEGORY_LABELS: Record<string, string> = {
  LandUnits: "Landeinheiten",
  Controlmeasure: "Kontrollmaßnahmen",
  LandInstallments: "Landinstallationen",
  Activity: "Aktivitäten",
  SeaSurface: "Seeoberfläche",
  Air: "Luft",
  Personel: "Personal",
  Static: "Statisch",
  HQ: "Hauptquartier",
  Faction: "Fraktion",
};

function categoryKey(languageKey: string): string {
  const p = languageKey.split("-");
  return p.length > 2 ? p[2] : "Sonstige";
}

export function groupByCategory(entries: CatalogEntry[]): CatalogCategory[] {
  const by = new Map<string, CatalogEntry[]>();
  for (const e of entries) {
    const k = categoryKey(e.languageKey);
    (by.get(k) ?? by.set(k, []).get(k)!).push(e);
  }
  return [...by.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((k) => ({
      key: k,
      label: CATEGORY_LABELS[k] ?? k,
      entries: (by.get(k) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

async function tryFetch<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { credentials: "include" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null; // Netzwerkfehler soll die Kartenansicht nie blockieren
  }
}

let _cat: Promise<CatalogCategory[] | null> | null = null;
export function loadAllMarkers(): Promise<CatalogCategory[] | null> {
  _cat ??= tryFetch<{ markers: CatalogEntry[] }>("/api/catalog/all-markers").then((d) =>
    d ? groupByCategory(d.markers ?? []) : null,
  );
  return _cat;
}

let _quick: Promise<QuickMenuCatalog | null> | null = null;
export function loadQuickMenu(): Promise<QuickMenuCatalog | null> {
  _quick ??= tryFetch<QuickMenuCatalog>("/api/catalog/quick-menu");
  return _quick;
}

let _chan: Promise<ChannelSettings | null> | null = null;
export function loadChannels(): Promise<ChannelSettings | null> {
  _chan ??= tryFetch<ChannelSettings>("/api/catalog/channels");
  return _chan;
}

let _phase: Promise<PhaseLineStyle | null> | null = null;
export function loadPhaseLineStyle(): Promise<PhaseLineStyle | null> {
  _phase ??= tryFetch<PhaseLineStyle>("/api/catalog/phaseline-style");
  return _phase;
}

// ── #Namen → lesbarer Name (Admin lädt SIDC_Translations.json nach) ──────────
let _trMap: Record<string, string> = {};
let _tr: Promise<Record<string, string>> | null = null;

function flattenTranslations(d: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!d || typeof d !== "object") return out;
  const obj = d as Record<string, unknown>;
  const arr =
    (Array.isArray(obj) && obj) ||
    (Array.isArray(obj.entries) && obj.entries) ||
    (Array.isArray(obj.translations) && obj.translations) ||
    null;
  if (arr) {
    for (const e of arr as Record<string, unknown>[]) {
      const k = (e.key ?? e.languageKey ?? e.id) as string | undefined;
      const v = (e.value ?? e.name ?? e.text ?? e.translation) as string | undefined;
      if (typeof k === "string" && typeof v === "string") out[k] = v;
    }
    return out;
  }
  const src = (obj.translations && typeof obj.translations === "object"
    ? obj.translations
    : obj) as Record<string, unknown>;
  for (const [k, v] of Object.entries(src)) if (typeof v === "string") out[k] = v;
  return out;
}

export function loadTranslations(): Promise<Record<string, string>> {
  _tr ??= tryFetch<unknown>("/api/catalog/translations").then((d) => {
    _trMap = flattenTranslations(d);
    return _trMap;
  });
  return _tr;
}

/** #Name → lesbarer Name; ohne Tabelle bzw. bei Fehltreffer heuristische Bereinigung. */
export function translate(raw: string | undefined | null): string {
  if (!raw) return raw ?? "";
  if (_trMap[raw]) return _trMap[raw];
  return raw
    .replace(/^#SIDC-Channel-/, "")
    .replace(/^#SIDC-UI-text_/, "")
    .replace(/^#SIDC-[A-Za-z]+-/, "")
    .replace(/^#/, "")
    .replace(/_/g, " ");
}

let _mods: Promise<ModifierCatalog | null> | null = null;
export function loadModifiers(): Promise<ModifierCatalog | null> {
  _mods ??= tryFetch<ModifierCatalog>("/api/catalog/modifiers");
  return _mods;
}

/** markerDescription (QuickMenuButton) → CatalogEntry über alle Kategorien. */
export function findEntry(cats: CatalogCategory[], description: string): CatalogEntry | undefined {
  if (description.startsWith("#")) {
    for (const c of cats) {
      const hit = c.entries.find((e) => e.languageKey === description);
      if (hit) return hit;
    }
    return undefined;
  }
  for (const c of cats) {
    const hit = c.entries.find((e) => e.name === description);
    if (hit) return hit;
  }
  return undefined;
}

export function channelLabel(c: { name: string; languageKey: string }): string {
  return translate(c.languageKey || c.name);
}
