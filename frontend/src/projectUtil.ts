// Gemeinsame Helfer der Missionsbau-Projekte (Tabs: Dokumente, Aufgaben, Whiteboard, Übersicht, Mitglieder).
import type { Me, ProjectDetail, ProjectRole } from "./api";
import { getLang, t } from "./i18n";

/** Kontext, den projects.ts an jeden Tab weiterreicht. */
export interface ProjCtx {
  id: string;
  project: ProjectDetail;
  me: Me;
  role: ProjectRole;
  /** editor oder owner (oder Admin): darf schreiben */
  canEdit: boolean;
  isOwner: boolean;
  /** darf den Bereich „Missionsbau" sehen */
  isBuilder: boolean;
}

export const POLL_MS = 5000;

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

/** „vor 5 Min." / „5 min ago" */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const s = Math.max(0, ms / 1000);
  const de = getLang() === "de";
  const u = (n: number, d: string, e: string) => (de ? `vor ${n} ${d}` : `${n} ${e} ago`);
  if (s < 60) return t("proj.justNow");
  if (s < 3600) return u(Math.round(s / 60), "Min.", "min");
  if (s < 86400) return u(Math.round(s / 3600), "Std.", "h");
  return u(Math.round(s / 86400), "Tg.", "d");
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return "";
  const dt = new Date(d.length <= 10 ? d + "T00:00:00" : d);
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString(getLang() === "de" ? "de-DE" : "en-GB");
}

/** Heutiges Datum lokal als YYYY-MM-DD. */
export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Wiederkehrendes Nachladen (Polling). Läuft nur, solange `host` im DOM hängt und der Tab sichtbar ist;
 * `busy()` pausiert (Ziehen, Tippen, offener Dialog). Räumt sich beim Verlassen der Ansicht (hashchange) auf.
 */
export function startPolling(host: HTMLElement, fn: () => Promise<void> | void, busy: () => boolean = () => false, ms = POLL_MS): () => void {
  let stopped = false;
  let running = false;
  const timer = window.setInterval(async () => {
    if (stopped) return;
    if (!host.isConnected) return stop();
    if (document.hidden || busy() || running) return;
    running = true;
    try {
      await fn();
    } catch {
      /* nächster Versuch beim nächsten Takt */
    } finally {
      running = false;
    }
  }, ms);
  const onHash = () => stop();
  function stop(): void {
    if (stopped) return;
    stopped = true;
    window.clearInterval(timer);
    window.removeEventListener("hashchange", onHash);
  }
  window.addEventListener("hashchange", onHash);
  return stop;
}

/** Laufende Dialoge (promptDialog/confirmDialog/Modal) zählen als „beschäftigt". */
export function modalOpen(): boolean {
  return !!document.querySelector(".edit-modal, .wiz-backdrop");
}

/** Gemeinsame Pointer-Ziehhilfe: ruft move/up mit Pointer-Capture auf dem Element auf. */
export function dragWith(
  el: HTMLElement,
  e: PointerEvent,
  onMove: (ev: PointerEvent) => void,
  onUp: (ev: PointerEvent, moved: boolean) => void,
  threshold = 0,
): void {
  const sx = e.clientX;
  const sy = e.clientY;
  let moved = threshold === 0;
  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  const mv = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) return;
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < threshold) return;
    moved = true;
    onMove(ev);
  };
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) return;
    el.removeEventListener("pointermove", mv);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", up);
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    onUp(ev, moved);
  };
  el.addEventListener("pointermove", mv);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
}
