// Einheitliches Icon-Set (Duotone-Linienstil, 24er-Raster). Ersetzt Emojis.
// icon("name") -> <svg>…</svg>-String. Farbe folgt currentColor; die optionale
// Akzentfläche nutzt .ic-a (CSS: fill var(--accent-weak)).

type P = string;

const A = (d: P) => `<path class="ic-a" d="${d}"/>`; // Akzentfläche (nur fill)
const L = (d: P) => `<path d="${d}"/>`; // Kontur (nur stroke)

const ICONS: Record<string, string> = {
  // Navigation / allgemein
  back: L("M15 6l-6 6 6 6"),
  chevron: L("M9 6l6 6-6 6"),
  chevronDown: L("M6 9l6 6 6-6"),
  x: L("M6 6l12 12M18 6L6 18"),
  check: L("M5 13l4 4L19 7"),
  plus: L("M12 5v14M5 12h14"),
  minus: L("M5 12h14"),
  search: L("M11 4a7 7 0 105 12l4 4M11 4a7 7 0 015 12"),
  trash: L("M5 7h14M10 7V5h4v2M6 7l1 12h10l1-12"),
  edit: L("M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4"),
  clone: L("M9 9h10v10H9zM5 15H4V4h11v1"),
  download: L("M12 4v10m0 0l-4-4m4 4l4-4M5 19h14"),
  settings: `${A("M12 9a3 3 0 100 6 3 3 0 000-6z")}${L("M12 9a3 3 0 100 6 3 3 0 000-6z")}${L("M19.4 13a7.8 7.8 0 000-2l2-1.5-2-3.4-2.3 1a7.8 7.8 0 00-1.7-1l-.4-2.6h-4l-.3 2.6a7.8 7.8 0 00-1.8 1l-2.3-1-2 3.4L4.6 11a7.8 7.8 0 000 2l-2 1.5 2 3.4 2.3-1a7.8 7.8 0 001.8 1l.3 2.6h4l.4-2.6a7.8 7.8 0 001.7-1l2.3 1 2-3.4z")}`,
  keyboard: `${L("M3 6h18v12H3z")}${L("M7 10h.01M11 10h.01M15 10h.01M8 14h8")}`,
  logout: L("M9 5H5v14h4M14 8l4 4-4 4M18 12H9"),
  users: `${A("M9 11a3 3 0 100-6 3 3 0 000 6z")}${L("M9 11a3 3 0 100-6 3 3 0 000 6zM3 20a6 6 0 0112 0M17 7a3 3 0 010 6M18 20a6 6 0 00-3-5.2")}`,
  groups: L("M7 10a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM17 10a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM2 19a5 5 0 019-3M13 16a5 5 0 019 3"),
  audit: `${L("M6 3h9l4 4v14H6z")}${L("M9 12h6M9 16h6M9 8h3")}`,
  map: `${A("M9 4l6 2 5-2v14l-5 2-6-2-5 2V6z")}${L("M9 4l6 2 5-2v14l-5 2-6-2-5 2V6zM9 4v14M15 6v14")}`,

  // Kartenwerkzeuge
  pan: L("M9 11V5.5a1.5 1.5 0 013 0V11m0-1.5a1.5 1.5 0 013 0V11m0 0a1.5 1.5 0 013 0v3a6 6 0 01-6 6h-1.2a5 5 0 01-3.7-1.7l-3-3.3a1.6 1.6 0 012.3-2.2L9 15V6a1.5 1.5 0 013 0"),
  move: L("M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"),
  markerMove: `${A("M12 4a5 5 0 015 5c0 3.5-5 9-5 9")}${L("M12 4a5 5 0 015 5c0 3.5-5 9-5 9s-5-5.5-5-9a5 5 0 015-5z")}${L("M5 20h14")}`,
  point: L("M7 3l4 16 2-6 6-2z"),
  line: L("M5 19L19 5M5 5h2v2H5zM17 17h2v2h-2z"),
  ruler: `${A("M4 14L14 4l6 6L10 20z")}${L("M4 14L14 4l6 6L10 20z")}${L("M8 8l2 2M11 5l2 2M5 11l2 2")}`,
  eraser: `${L("M8 20H5l-2-2a2 2 0 010-3l9-9 6 6-8 8z")}${L("M8 20h12M8 14l6 6")}`,
  marker: `${A("M12 3a6 6 0 016 6c0 4.2-6 12-6 12S6 13.2 6 9a6 6 0 016-6z")}${L("M12 3a6 6 0 016 6c0 4.2-6 12-6 12S6 13.2 6 9a6 6 0 016-6z")}${L("M12 9h.01")}`,
  star: `${A("M12 4l2.5 5 5.5.8-4 3.9 1 5.5-5-2.6-5 2.6 1-5.5-4-3.9 5.5-.8z")}${L("M12 4l2.5 5 5.5.8-4 3.9 1 5.5-5-2.6-5 2.6 1-5.5-4-3.9 5.5-.8z")}`,
  layers: `${A("M12 3l9 5-9 5-9-5z")}${L("M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5")}`,
  cube3d: `${A("M12 3l8 4.5v9L12 21l-8-4.5v-9z")}${L("M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5")}`,
  compass: `${A("M12 12l5-5-2 7-7 2z")}${L("M12 21a9 9 0 100-18 9 9 0 000 18zM12 12l5-5-2 7-7 2z")}`,
  north: `${L("M12 21V6")}${A("M12 3l4 5H8z")}${L("M12 3l4 5H8z")}`,
  camera: `${A("M4 8h4l2-3h4l2 3h4v11H4z")}${L("M4 8h4l2-3h4l2 3h4v11H4zM12 16a3.5 3.5 0 100-7 3.5 3.5 0 000 7z")}`,
  calendar: `${L("M4 6h16v14H4zM4 10h16M8 3v4M16 3v4")}`,
  notes: `${A("M6 3h9l4 4v14H6z")}${L("M6 3h9l4 4v14H6zM15 3v4h4M9 12h6M9 16h4")}`,
  versions: `${L("M12 8v5l3 2")}${L("M3.5 12a8.5 8.5 0 108.5-8.5A8.5 8.5 0 004 8M4 4v4h4")}`,
  help: `${A("M12 21a9 9 0 100-18 9 9 0 000 18z")}${L("M12 21a9 9 0 100-18 9 9 0 000 18zM9.5 9.5a2.5 2.5 0 013.9-2c1.6 1 .9 3-1.4 3.7V13M12 16.5h.01")}`,
  channel: `${L("M12 14a2 2 0 100-4 2 2 0 000 4z")}${L("M7.5 7.5a6 6 0 000 9M16.5 7.5a6 6 0 010 9M5 5a9 9 0 000 14M19 5a9 9 0 010 14")}`,
  lock: `${A("M6 11h12v9H6z")}${L("M6 11h12v9H6zM9 11V8a3 3 0 016 0v3")}`,
  unlock: `${A("M6 11h12v9H6z")}${L("M6 11h12v9H6zM9 11V8a3 3 0 015.8-1")}`,
  folder: `${A("M3 7h6l2 2h10v10H3z")}${L("M3 7h6l2 2h10v10H3z")}`,
  folderOpen: `${A("M3 7h6l2 2h10v10H3z")}${L("M3 7h6l2 2h9M3 7v12h16l2-8H7z")}`,
  drag: L("M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01"),
  pin: `${A("M9 4h6l-1 6 3 3H7l3-3z")}${L("M9 4h6l-1 6 3 3H7l3-3zM12 16v4")}`,

  // Theme
  sun: `${A("M12 16a4 4 0 100-8 4 4 0 000 8z")}${L("M12 16a4 4 0 100-8 4 4 0 000 8zM12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4")}`,
  moon: `${A("M20 14a8 8 0 01-10-10 8 8 0 1010 10z")}${L("M20 14a8 8 0 01-10-10 8 8 0 1010 10z")}`,
  monitor: L("M4 5h16v11H4zM9 20h6M12 16v4"),
  present: `${A("M10 9l5 3-5 3z")}${L("M4 5h16v11H4zM9 20h6M12 16v4M10 9l5 3-5 3z")}`,
  undo: L("M9 7L4 12l5 5M4 12h11a5 5 0 010 10h-3"),
  redo: L("M15 7l5 5-5 5M20 12H9a5 5 0 000 10h3"),
  textbox: `${A("M5 5h14v14H5z")}${L("M5 5h14v14H5zM9 9h6M9 12h6M9 15h3")}`,
  pdf: `${L("M7 3h8l4 4v14H7z")}${A("M7 3h8l4 4v14H7z")}${L("M15 3v4h4M9 13h1.5a1.5 1.5 0 000-3H9zM14 10h3M14 10v6")}`,
};

export function icon(name: keyof typeof ICONS | string, size = 20): string {
  const body = ICONS[name] ?? ICONS.help;
  return `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;
}

export const ICON_NAMES = Object.keys(ICONS);
