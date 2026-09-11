// Geteilte Einstellungs-Panels für Plan-Bilder.
//
// renderImageSettings   — Bild-Metadaten (Name/Notiz/Phase-Zuordnung in der
//                          Sidebar, Liste der Platzierungen, Löschen). Wird in
//                          der rechten Bild-Sidebar hinterm Zahnrad verwendet.
// renderPlacementSettings — Einstellungen EINER Platzierung auf der Karte
//                          (eigene Phase, Skalieren, diese Platzierung
//                          entfernen). Wird im Zahnrad-Popover am Kartenbild
//                          verwendet — ein Bild kann mehrere Platzierungen haben.
import type { PlanImage } from "./api";
import { t } from "./i18n";
import { icon } from "./icons";
import { esc } from "./esc";
import { renderMarkdown } from "./md";

export interface ImgPanelPhase {
  id: string;
  name: string;
  plane?: "player" | "builder";
}

export interface PlacementLike {
  id: string;
  image_id: string;
  phase_id: string | null;
  world_x: number;
  world_y: number;
  map_width: number;
  scale_fixed: boolean;
  ref_zoom: number;
}

export interface ImgPanelCtx {
  isMB: boolean;
  phases: ImgPanelPhase[];
  send: (m: { type: string; [k: string]: unknown }) => void;
  getMapCenter: () => { lng: number; lat: number };
  getMapZoom: () => number;
  getCurrentPhaseId: () => string;
  /** Alle aktuellen Platzierungen dieses Bilds (für die "Platzierungen"-Liste). */
  placementsOf: (imageId: string) => PlacementLike[];
  /** Nach jeder Änderung, die eine Karten-/Listen-Aktualisierung braucht. */
  onChanged?: () => void;
  /** Nach dem Löschen des ganzen Bilds — z. B. Panel schließen. */
  onDeleted?: () => void;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function phaseOptions(phases: ImgPanelPhase[], isMB: boolean, selected: string | null): string {
  const list = isMB ? phases : phases.filter((p) => p.plane !== "builder");
  return (
    `<option value="">${t("phase.global")}</option>` +
    list
      .map(
        (p) =>
          `<option value="${esc(p.id)}" ${p.id === selected ? "selected" : ""}>${p.plane === "builder" ? "⚑ " : ""}${esc(p.name)}</option>`,
      )
      .join("")
  );
}

/** Bild-Metadaten-Panel (Sidebar-Zahnrad): Phase-Einsortierung, Notiz, Liste
 * der Platzierungen auf der Karte, Löschen. Rendert in `host` (muss bereits im
 * DOM hängen) und verdrahtet es neu. */
export function renderImageSettings(host: HTMLElement, img: PlanImage, ctx: ImgPanelCtx): void {
  const placements = ctx.placementsOf(img.id);
  const placementRows = placements
    .map((p) => {
      const ph = ctx.phases.find((x) => x.id === p.phase_id);
      const label = ph ? `${ph.plane === "builder" ? "⚑ " : ""}${ph.name}` : t("phase.global");
      return `<div class="is-place-row" data-is-place="${esc(p.id)}">
        <span>${esc(label)}</span>
        <button class="icon-btn" data-is-place-rm title="${t("img.removePlacement")}">${icon("x", 12)}</button>
      </div>`;
    })
    .join("");

  host.innerHTML = `
    <label class="is-lbl">${t("phase.assign")}<select data-is-phase>${phaseOptions(ctx.phases, ctx.isMB, img.phase_id)}</select></label>
    <label class="is-lbl">${t("img.note")}</label>
    <textarea class="is-note" data-is-note placeholder="${t("img.noteHint")}">${esc(img.note || "")}</textarea>
    <div class="is-note-prev" data-is-noteprev>${renderMarkdown(img.note || "")}</div>
    <label class="is-lbl">${t("img.placements")}</label>
    <div class="is-places" data-is-places>${placementRows || `<span class="muted is-meta">${t("img.noPlacements")}</span>`}</div>
    <button type="button" class="is-place-add" data-is-place-add>${icon("plus", 12)} ${t("img.placeHere")}</button>
    <div class="is-foot">
      <span class="muted is-meta">${esc(img.filename)} · ${fmtBytes(img.byte_size)}</span>
      <div class="is-foot-actions" data-is-actions>
        <button class="icon-btn" data-is-del title="${t("img.delete")}">${icon("trash", 14)}</button>
      </div>
    </div>`;

  host.querySelector<HTMLSelectElement>("[data-is-phase]")!.addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value || null;
    img.phase_id = v;
    ctx.send({ type: "image.modify", id: img.id, data: { phase_id: v } });
    ctx.onChanged?.();
  });

  let noteTimer = 0;
  const noteEl = host.querySelector<HTMLTextAreaElement>("[data-is-note]")!;
  const prevEl = host.querySelector<HTMLElement>("[data-is-noteprev]")!;
  const sendNote = () => {
    window.clearTimeout(noteTimer);
    img.note = noteEl.value;
    ctx.send({ type: "image.modify", id: img.id, data: { note: img.note, phase_id: img.phase_id } });
  };
  noteEl.addEventListener("input", () => {
    prevEl.innerHTML = renderMarkdown(noteEl.value);
    window.clearTimeout(noteTimer);
    noteTimer = window.setTimeout(sendNote, 600);
  });
  noteEl.addEventListener("blur", sendNote);

  host.querySelectorAll<HTMLButtonElement>("[data-is-place-rm]").forEach((b) => {
    b.addEventListener("click", () => {
      const row = b.closest<HTMLElement>("[data-is-place]")!;
      ctx.send({ type: "placement.delete", id: row.dataset.isPlace! });
      ctx.onChanged?.();
    });
  });
  host.querySelector("[data-is-place-add]")?.addEventListener("click", () => {
    const c = ctx.getMapCenter();
    ctx.send({
      type: "placement.create",
      data: {
        image_id: img.id, phase_id: ctx.getCurrentPhaseId() || null,
        world_x: c.lng, world_y: c.lat, ref_zoom: ctx.getMapZoom(),
      },
    });
    ctx.onChanged?.();
  });

  host.querySelector("[data-is-del]")!.addEventListener("click", () => {
    const actions = host.querySelector<HTMLElement>("[data-is-actions]")!;
    actions.innerHTML =
      `<label class="ir-delok"><input type="checkbox" data-is-delok/> ${t("common.delete")}</label>` +
      `<button class="icon-btn" data-is-delcancel title="${t("common.cancel")}">${icon("back", 12)}</button>`;
    actions.querySelector("[data-is-delok]")!.addEventListener("change", () => {
      ctx.send({ type: "image.delete", id: img.id });
      ctx.onDeleted?.();
    });
    actions.querySelector("[data-is-delcancel]")!.addEventListener("click", () => renderImageSettings(host, img, ctx));
  });
}

export interface PlacementPanelCtx {
  isMB: boolean;
  phases: ImgPanelPhase[];
  send: (m: { type: string; [k: string]: unknown }) => void;
  getMapZoom: () => number;
  /** Nach jeder Änderung (Phase, Skalieren). */
  onChanged?: () => void;
  /** Nach dem Entfernen dieser Platzierung — z. B. Popover schließen. */
  onDeleted?: () => void;
}

/** Einstellungen EINER Kartenplatzierung (Zahnrad-Popover am Bild): eigene
 * Phase, Skalieren mit der Karte, diese Platzierung entfernen (löscht NICHT
 * das Bild selbst — das kann weiterhin in anderen Phasen platziert sein). */
export function renderPlacementSettings(host: HTMLElement, placement: PlacementLike, ctx: PlacementPanelCtx): void {
  host.innerHTML = `
    <label class="is-lbl">${t("phase.assign")}<select data-ps-phase>${phaseOptions(ctx.phases, ctx.isMB, placement.phase_id)}</select></label>
    <label class="ir-chk"><input type="checkbox" data-ps-scale ${placement.scale_fixed ? "checked" : ""}/> ${t("img.scaleWithMap")}</label>
    <div class="is-foot">
      <span class="grow"></span>
      <div class="is-foot-actions" data-ps-actions>
        <button class="icon-btn" data-ps-del title="${t("img.removePlacement")}">${icon("trash", 14)}</button>
      </div>
    </div>`;

  host.querySelector<HTMLSelectElement>("[data-ps-phase]")!.addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value || null;
    placement.phase_id = v;
    ctx.send({ type: "placement.modify", id: placement.id, data: { phase_id: v } });
    ctx.onChanged?.();
  });
  host.querySelector<HTMLInputElement>("[data-ps-scale]")!.addEventListener("change", (e) => {
    const on = (e.target as HTMLInputElement).checked;
    placement.scale_fixed = on;
    const data: Record<string, unknown> = { scale_fixed: on, phase_id: placement.phase_id };
    if (on && (!placement.ref_zoom || placement.ref_zoom <= 0)) {
      placement.ref_zoom = ctx.getMapZoom();
      data.ref_zoom = placement.ref_zoom;
    }
    ctx.send({ type: "placement.modify", id: placement.id, data });
    ctx.onChanged?.();
  });
  host.querySelector("[data-ps-del]")!.addEventListener("click", () => {
    const actions = host.querySelector<HTMLElement>("[data-ps-actions]")!;
    actions.innerHTML =
      `<label class="ir-delok"><input type="checkbox" data-ps-delok/> ${t("common.delete")}</label>` +
      `<button class="icon-btn" data-ps-delcancel title="${t("common.cancel")}">${icon("back", 12)}</button>`;
    actions.querySelector("[data-ps-delok]")!.addEventListener("change", () => {
      ctx.send({ type: "placement.delete", id: placement.id });
      ctx.onDeleted?.();
    });
    actions.querySelector("[data-ps-delcancel]")!.addEventListener("click", () => renderPlacementSettings(host, placement, ctx));
  });
}

/** True, solange der Nutzer gerade in der Notiz dieses Panels tippt — Aufrufer
 * sollten währenddessen keinen destruktiven Neuaufbau (innerHTML=…) machen. */
export function isEditingImageNote(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && el.matches("[data-is-note]");
}
