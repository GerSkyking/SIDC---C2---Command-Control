// Info-Fenster zu einem Marker (Hotkey „I“ über dem Marker): Name, Bedeutung des Symbols,
// Layer, Autor und Phase. Unabhängig vom Haken „Marker-Info“ im Ebenen-Panel.
import { esc } from "../esc";
import { t } from "../i18n";
import { icon } from "../icons";
import type { Marker, PlanCtx } from "./ctx";

export function openMarkerInfo(ctx: PlanCtx, m: Marker): void {
  const { markerLabel, markerInfoText, phaseNameOf } = ctx.model;
  const layer = ctx.tacLayers.find((l) => l.id === m.layer_id)?.name;
  const meaning = markerInfoText(m.sidc);
  const rows: [string, string][] = [
    ...(layer ? ([[t("wiz.layer"), layer]] as [string, string][]) : []),
    [t("marker.author"), m.author || "—"],
    [t("phase.assign"), phaseNameOf(m.phase_id)],
  ];
  const back = document.createElement("div");
  back.className = "edit-modal";
  back.setAttribute("role", "dialog");
  back.setAttribute("aria-modal", "true");
  back.innerHTML = `<div class="card stack mk-info-dlg" style="width:min(30rem,96vw)">
    <div class="row"><h1 style="flex:1;margin:0;overflow-wrap:anywhere">${esc(markerLabel(m) || "—")}</h1>
      <button class="icon-btn" data-x title="${t("common.close")}">${icon("x")}</button></div>
    <div class="mk-info-meaning">${
      meaning ? esc(meaning).replace(/\n/g, "<br>") : `<span class="muted">${t("marker.infoNone")}</span>`
    }</div>
    <dl class="mk-info-rows">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
  </div>`;
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    back.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    close();
  };
  document.addEventListener("keydown", onKey, true);
  back.addEventListener("mousedown", (e) => {
    if (e.target === back) close();
  });
  back.querySelector("[data-x]")!.addEventListener("click", close);
  document.body.append(back);
}
