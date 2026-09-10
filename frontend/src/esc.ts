// Zentrales HTML-Escaping für Template-Strings, die per innerHTML gesetzt werden.
// `esc` deckt Text- und (doppelt-quotierten) Attribut-Kontext ab.
const MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"'`]/g, (c) => MAP[c]);
}
