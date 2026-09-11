// SIDC-Zusammenbau — portiert aus ATAKmaps web/src/sidc-marker/sidc/lookup.ts.
// Katalog-SIDC trägt an Index 3 nur einen Platzhalter; Affiliation (+ ggf. Echelon)
// wird vor dem Absenden reingespliced, genau wie im ingame-UI.

const IDX_AFF = 3;
const IDX_ECH = 8;
const LEN = 30;

function normalize(sidc: string): string {
  let s = sidc.length > LEN ? sidc.slice(0, LEN) : sidc;
  while (s.length < LEN) s += "0";
  return s;
}

export function withAffiliation(base: string, affDigit: string): string {
  const s = normalize(base);
  return s.slice(0, IDX_AFF) + affDigit + s.slice(IDX_AFF + 1);
}

export function withAffiliationAndEchelon(base: string, affDigit: string, echelon: string): string {
  const s = normalize(base);
  return s.slice(0, IDX_AFF) + affDigit + s.slice(IDX_AFF + 1, IDX_ECH) + echelon + s.slice(IDX_ECH + 2);
}

export interface SidcModifiers {
  m1?: number; // Modifier 1  → Stellen 17-18 (0-idx 16)
  m2?: number; // Modifier 2  → Stellen 19-20 (0-idx 18)
  m3?: number; // HQ/TF/Dummy → Stelle 8 (0-idx 7)
  m4?: number; // Status/Zustand → Stelle 7 (0-idx 6)
}
function put(s: string, at: number, val: string): string {
  return s.slice(0, at) + val + s.slice(at + val.length);
}
export function withModifiers(base: string, m: SidcModifiers): string {
  let s = normalize(base);
  if (m.m4 != null) s = put(s, 6, String(m.m4 % 10));
  if (m.m3 != null) s = put(s, 7, String(m.m3 % 10));
  if (m.m1 != null) s = put(s, 16, String(m.m1 % 100).padStart(2, "0"));
  if (m.m2 != null) s = put(s, 18, String(m.m2 % 100).padStart(2, "0"));
  return s;
}

export function iconUrl(sidc: string): string {
  return `/assets/app6d-icons/${sidc}.png`;
}
export function arrowUrl(icon: string): string {
  return `/assets/arrows/${icon}`;
}

export interface AffiliationOption {
  digit: string;
  label: string;
}
// Nur die vier tatsächlich genutzten Zugehörigkeiten (kein "Assumed").
export const AFFILIATIONS: AffiliationOption[] = [
  { digit: "1", label: "Unknown" },
  { digit: "3", label: "Friend (BLUFOR)" },
  { digit: "4", label: "Neutral (INDFOR/Civilian)" },
  { digit: "6", label: "Hostile (OPFOR)" },
];

export const IDENTITY_TO_AFFILIATION: Record<string, string> = {
  UNKNOWN: "1",
  ASSUMED_BLUFOR: "3",
  BLUFOR: "3",
  INDFOR: "4",
  CIVILIAN: "4",
  ASSUMED_OPFOR: "6",
  OPFOR: "6",
};

export const AMPLIFIERS: { digits: string; label: string }[] = [
  { digits: "00", label: "Keiner" },
  { digits: "11", label: "Team/Crew" },
  { digits: "12", label: "Squad" },
  { digits: "13", label: "Section" },
  { digits: "14", label: "Platoon/Detachment" },
  { digits: "15", label: "Company/Battery/Troop" },
  { digits: "16", label: "Battalion/Squadron" },
  { digits: "17", label: "Regiment/Group" },
  { digits: "18", label: "Brigade" },
  { digits: "19", label: "Division" },
  { digits: "20", label: "Corps/MEF" },
  { digits: "21", label: "Army" },
];

export interface DirectionOption {
  label: string;
  degrees: number;
  icon: string;
}
export const DIRECTIONS: DirectionOption[] = [
  { label: "Stationär", degrees: -1, icon: "" },
  { label: "N", degrees: 0, icon: "arrow_N.png" },
  { label: "NO", degrees: 45, icon: "arrow_NO.png" },
  { label: "O", degrees: 90, icon: "arrow_O.png" },
  { label: "SO", degrees: 135, icon: "arrow_SO.png" },
  { label: "S", degrees: 180, icon: "arrow_S.png" },
  { label: "SW", degrees: 225, icon: "arrow_SW.png" },
  { label: "W", degrees: 270, icon: "arrow_W.png" },
  { label: "NW", degrees: 315, icon: "arrow_NW.png" },
];

/** Kalibrierung aus Karten-Meta → Welt-Koordinaten (wie ATAKmaps index.html). */
export interface Calibration {
  origin_lon: number;
  origin_lat: number;
  scale_x: number;
  scale_y: number;
}
export function lngLatToWorld(cal: Calibration | null, lng: number, lat: number): [number, number] {
  if (!cal) return [lng, lat];
  return [(lng - cal.origin_lon) * cal.scale_x, (lat - cal.origin_lat) * cal.scale_y];
}
export function worldToLngLat(cal: Calibration | null, wx: number, wy: number): [number, number] {
  if (!cal) return [wx, wy];
  return [cal.origin_lon + wx / (cal.scale_x || 1), cal.origin_lat + wy / (cal.scale_y || 1)];
}
export function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}

/**
 * Funktions-IDs (Stellen 11-16 der SIDC) "linienhafter" Control-Measure-Symbole
 * (Phase Line, Boundary, CFL, Release Line, Line of Contact, ...) — diese teilen
 * sich zwar den Symbol-Set-Code "25" mit Punkt-Control-Measures (z. B. "Known
 * Point"), bekommen aber ein anderes Einheitstext-/Zusatztext-Layout. Extrahiert
 * aus SIDC-Framework/Configs/AllMarkers/AllMarkers.conf (Einträge mit
 * `m_bIsMultiPointLine 1`).
 */
const LINE_CM_FUNCTION_IDS = new Set<string>([
  "110100", "110200", "110300", "110500", "140100", "140200", "140300", "140400",
  "140602", "140603", "140605", "140700", "140800", "140900", "141000", "141100",
  "141200", "141300", "141400", "141500", "141600", "141800", "141900", "151401",
  "151402", "151406", "190100", "190200", "217100", "217300", "217400", "217500",
  "217600", "217700", "220100", "220101", "220102", "220103", "220104", "220105",
  "220106", "220107", "220108", "240701", "240702", "240703", "260100", "260200",
  "260300", "260400", "260500", "260600", "271202", "271203", "280100", "282003",
  "290100", "290101", "290201", "290202", "290203", "290204", "290301", "290302",
  "290303", "290304", "290305", "290306", "290307", "290308", "290500", "290600",
  "290700", "290800", "290900", "300100", "330100", "330300", "330301", "330302",
  "330303", "330400", "330401", "330402", "330403", "340800", "341200", "341300",
  "341900", "342000", "342201", "342202", "342203", "342400", "342500", "343100",
  "343300", "344000", "344100", "344200",
]);

/** Symbol-Set "25" (Control Measure) + Funktions-ID aus obiger Liste -> "line",
 * Symbol-Set "25" sonst -> "cm" (Punkt-Control-Measure), alles andere -> "default"
 * (Land Unit u. a.). Bestimmt, wo Einheitstext/Zusatztext relativ zum Symbol stehen. */
export type MarkerLabelCategory = "default" | "cm" | "line";
export function markerLabelCategory(sidc: string): MarkerLabelCategory {
  if (sidc.slice(4, 6) !== "25") return "default";
  return LINE_CM_FUNCTION_IDS.has(sidc.slice(10, 16)) ? "line" : "cm";
}
