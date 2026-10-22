// Kleine UI-Bausteine für Taktik-Layer und Mehrfach-Phasen (Wizard, Baukasten, Bearbeiten-Panel).
import { t } from "../i18n";

export interface LayerOpt {
  id: string;
  name: string;
}
export interface PhaseOpt {
  id: string;
  name: string;
  builder?: boolean;
}
/** Kontext für Marker-Vorlagen: welche eigenen Layer/Phasen stehen zur Auswahl. */
export interface TplCtx {
  layers?: LayerOpt[];
  layerId?: string | null;
  phases?: PhaseOpt[];
  phaseId?: string | null;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function layerSelectHtml(attr: string, layers: LayerOpt[], selected: string | null | undefined): string {
  return (
    `<select ${attr}><option value="">—</option>` +
    layers.map((l) => `<option value="${esc(l.id)}" ${l.id === selected ? "selected" : ""}>${esc(l.name)}</option>`).join("") +
    `</select>`
  );
}

/** Aufklappbare Mehrfachauswahl (Checkboxen) für weitere Phasen. */
export function phaseMultiHtml(attr: string, phases: PhaseOpt[], selected: string[], exclude?: string | null): string {
  const list = phases.filter((p) => p.id !== exclude);
  if (!list.length) return `<span class="muted">—</span>`;
  const n = selected.filter((id) => list.some((p) => p.id === id)).length;
  return (
    `<details class="ph-multi" ${attr}><summary>${n ? t("phase.extraCount").replace("{n}", String(n)) : t("phase.extraNone")}</summary>` +
    `<div class="ph-multi-body">` +
    list
      .map(
        (p) =>
          `<label class="chk"><input type="checkbox" value="${esc(p.id)}" ${selected.includes(p.id) ? "checked" : ""}/> ${p.builder ? "⚑ " : ""}${esc(p.name)}</label>`,
      )
      .join("") +
    `</div></details>`
  );
}

export function readPhaseMulti(root: ParentNode, attr: string): string[] {
  return [...root.querySelectorAll<HTMLInputElement>(`[${attr}] input:checked`)].map((i) => i.value);
}
