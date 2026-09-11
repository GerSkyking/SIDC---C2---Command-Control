// Geteiltes Einstellungs-Panel für ein Plan-Bild: Phase, "auf Karte", "mit
// Karte skalieren", Notiz (Markdown) und Löschen (Inline-Bestätigung wie bei
// Notizen). Wird sowohl in der rechten Bild-Sidebar (hinterm Zahnrad) als
// auch in einem Popover direkt am Kartenbild verwendet.
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

export interface ImgPanelCtx {
  isMB: boolean;
  phases: ImgPanelPhase[];
  send: (m: { type: string; [k: string]: unknown }) => void;
  getMapCenter: () => { lng: number; lat: number };
  getMapZoom: () => number;
  /** Nach jeder Änderung, die eine Karten-/Listen-Aktualisierung braucht (Phase, auf Karte, skalieren). */
  onChanged?: () => void;
  /** Nach dem Löschen — z. B. Popover schließen. */
  onDeleted?: () => void;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Rendert das Panel in `host` (muss bereits im DOM hängen) und verdrahtet es neu. */
export function renderImageSettings(host: HTMLElement, img: PlanImage, ctx: ImgPanelCtx): void {
  const phaseList = ctx.isMB ? ctx.phases : ctx.phases.filter((p) => p.plane !== "builder");
  const phaseOpts =
    `<option value="">${t("phase.global")}</option>` +
    phaseList
      .map(
        (p) =>
          `<option value="${esc(p.id)}" ${p.id === img.phase_id ? "selected" : ""}>${p.plane === "builder" ? "⚑ " : ""}${esc(p.name)}</option>`,
      )
      .join("");

  host.innerHTML = `
    <label class="is-lbl">${t("phase.assign")}<select data-is-phase>${phaseOpts}</select></label>
    <label class="ir-chk"><input type="checkbox" data-is-onmap ${img.on_map ? "checked" : ""}/> ${t("img.showOnMap")}</label>
    ${
      img.on_map
        ? `<label class="ir-chk"><input type="checkbox" data-is-scale ${img.scale_fixed ? "checked" : ""}/> ${t("img.scaleWithMap")}</label>`
        : ""
    }
    <label class="is-lbl">${t("img.note")}</label>
    <textarea class="is-note" data-is-note placeholder="${t("img.noteHint")}">${esc(img.note || "")}</textarea>
    <div class="is-note-prev" data-is-noteprev>${renderMarkdown(img.note || "")}</div>
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
  host.querySelector<HTMLInputElement>("[data-is-onmap]")!.addEventListener("change", (e) => {
    const on = (e.target as HTMLInputElement).checked;
    img.on_map = on;
    const data: Record<string, unknown> = { on_map: on, phase_id: img.phase_id };
    if (on && img.world_x === 0 && img.world_y === 0) {
      const c = ctx.getMapCenter();
      img.world_x = c.lng;
      img.world_y = c.lat;
      img.ref_zoom = ctx.getMapZoom();
      data.world_x = c.lng;
      data.world_y = c.lat;
      data.ref_zoom = img.ref_zoom;
    }
    ctx.send({ type: "image.modify", id: img.id, data });
    ctx.onChanged?.();
    renderImageSettings(host, img, ctx); // Skalieren-Checkbox ein-/ausblenden
  });
  host.querySelector<HTMLInputElement>("[data-is-scale]")?.addEventListener("change", (e) => {
    const on = (e.target as HTMLInputElement).checked;
    img.scale_fixed = on;
    const data: Record<string, unknown> = { scale_fixed: on, phase_id: img.phase_id };
    if (on && (!img.ref_zoom || img.ref_zoom <= 0)) {
      img.ref_zoom = ctx.getMapZoom();
      data.ref_zoom = img.ref_zoom;
    }
    ctx.send({ type: "image.modify", id: img.id, data });
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

/** True, solange der Nutzer gerade in der Notiz dieses Panels tippt — Aufrufer
 * sollten währenddessen keinen destruktiven Neuaufbau (innerHTML=…) machen. */
export function isEditingImageNote(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && el.matches("[data-is-note]");
}
