// Speicher für Oberflächen-Zustand (Position/Größe/Anheftung der Boxen): pro Benutzer auf dem Server
// (me.ui_settings.panels), localStorage dient als Cache und Rückfall (z. B. öffentliche Ansicht ohne Login).
import { api, type Me } from "./api";

let server: Record<string, string> = {};
let ready = false;
let timer = 0;

export function initUiStore(me: Me): void {
  const p = (me.ui_settings as Record<string, unknown> | undefined)?.panels;
  server = {};
  if (p && typeof p === "object") {
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) if (typeof v === "string") server[k] = v;
  }
  ready = true;
}

const save = (): void => {
  if (!ready) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void api.saveSettings({ panels: server }).catch(() => {}), 800);
};

export const uiGet = (k: string): string | null => {
  if (k in server) return server[k];
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
export const uiSet = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
  if (ready) {
    server[k] = v;
    save();
  }
};
export const uiRemove = (k: string): void => {
  try {
    localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
  if (ready && k in server) {
    delete server[k];
    save();
  }
};
