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
