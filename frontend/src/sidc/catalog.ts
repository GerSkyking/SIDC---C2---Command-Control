// Lädt die vom Admin hochgeladenen SIDC-Kataloge (Format 1:1 wie ingame LocalMapData).

export interface CatalogEntry {
  name: string;
  sidc: string;
  languageKey: string;
  isMultiPointLine?: boolean;
  maxLinePoints?: number;
  defaultTimestampVisible?: boolean;
  defaultLocked?: boolean;
}
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
  const n = c.languageKey || c.name;
  return n.replace(/^#SIDC-Channel-/, "").replace(/^#SIDC-UI-text_/, "").replace(/^#/, "");
}
