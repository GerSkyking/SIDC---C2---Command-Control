// Theme-Umschaltung: Dunkel (Standard) / Hell / System.
// Gespeichert pro Browser in localStorage["sidc_theme"].

export type ThemeChoice = "dark" | "light" | "system";

const KEY = "sidc_theme";
let choice: ThemeChoice = "dark";
const mql = window.matchMedia("(prefers-color-scheme: light)");
const listeners = new Set<(c: ThemeChoice) => void>();

function effective(c: ThemeChoice): "dark" | "light" {
  if (c === "system") return mql.matches ? "light" : "dark";
  return c;
}

function apply(): void {
  document.documentElement.dataset.theme = effective(choice);
}

export function initTheme(): void {
  try {
    const saved = localStorage.getItem(KEY) as ThemeChoice | null;
    if (saved === "dark" || saved === "light" || saved === "system") choice = saved;
  } catch {
    /* ignore */
  }
  apply();
  // Systemwechsel live nachziehen, wenn "system" gewählt ist.
  const onChange = () => {
    if (choice === "system") apply();
  };
  if (mql.addEventListener) mql.addEventListener("change", onChange);
  else mql.addListener(onChange);
}

export function getTheme(): ThemeChoice {
  return choice;
}

export function setTheme(c: ThemeChoice): void {
  choice = c;
  try {
    localStorage.setItem(KEY, c);
  } catch {
    /* ignore */
  }
  apply();
  listeners.forEach((f) => f(c));
}

export function onThemeChange(fn: (c: ThemeChoice) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
