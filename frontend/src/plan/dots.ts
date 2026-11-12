// Punkt-Werkzeug: einfachen Punkt in beliebiger Farbe mit frei wählbarem Text setzen.
// Gespeichert als Stroke kind "dot" (genau 1 Punkt, color = Farbe, width = Größe, name = Text) — Anlegen,
// Ändern, Löschen, Verschieben und Undo/Redo laufen über die Linien-Logik in strokes.ts.
// Panel #dotStyle (wie #lineStyle): Farbe (Linienpalette + freie Farbwahl), Größe, Text, Phase, Zusatzphasen, Layer.
import { esc } from "../esc";
import { t } from "../i18n";
import { icon } from "../icons";
import { confirmDialog } from "../notify";
import { DOT_DEFAULT_SIZE, DOT_KIND, DOT_SIZES } from "../mapAreas";
import { layerSelectHtml, phaseMultiHtml, readPhaseMulti } from "../sidc/layerui";
import type { LineColor, LngLat2, PlanCtx } from "./ctx";
import { hexToPacked, packedToHex } from "./geo";
import { isStrokeDot } from "./render";

const STYLE_KEY = "sidc_dot_style"; // zuletzt gewählte Farbe/Größe (nur für mich)

/** Größen-Auswahl (klein/mittel/groß) als <option>-Liste. */
const sizeOptions = (sel: number): string =>
  DOT_SIZES.map(
    (w, i) => `<option value="${w}" ${w === sel ? "selected" : ""}>${t(["dot.sizeS", "dot.sizeM", "dot.sizeL"][i])}</option>`,
  ).join("");
/** Nächstliegende Standardgröße (für ältere/fremde Werte). */
const nearestSize = (w: number): number =>
  DOT_SIZES.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a), DOT_DEFAULT_SIZE as number);

/** Farbfeld: Linienpalette als Knöpfe + freie Farbwahl; ``data-pc`` = gepackte Farbe. */
function colorBoxHtml(colors: LineColor[], cur: number): string {
  const inPalette = colors.some((c) => c.packedColor === cur);
  return (
    colors
      .map(
        (c) =>
          `<button type="button" data-pc="${c.packedColor}" title="${esc(c.name)}" style="background:rgb(${c.red},${c.green},${c.blue})" class="${
            c.packedColor === cur ? "active" : ""
          }"></button>`,
      )
      .join("") +
    `<input type="color" data-dfree value="${packedToHex(cur)}" class="${inPalette ? "" : "active"}" title="${t("dot.freeColor")}" aria-label="${t("dot.freeColor")}" />`
  );
}
/** Farbfeld verdrahten; ``onPick`` erhält die gepackte Farbe. */
function wireColorBox(box: HTMLElement, colors: LineColor[], get: () => number, onPick: (c: number) => void): void {
  const redraw = () => (box.innerHTML = colorBoxHtml(colors, get()));
  redraw();
  box.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-pc]");
    if (!b) return;
    onPick(Number(b.dataset.pc));
    redraw();
  });
  // "input" während des Ziehens im Farbwähler, ohne das Feld neu aufzubauen (sonst schließt der Wähler)
  box.addEventListener("input", (e) => {
    const inp = e.target as HTMLInputElement;
    if (!inp.matches("[data-dfree]")) return;
    onPick(hexToPacked(inp.value));
    box.querySelectorAll("[data-pc]").forEach((x) => x.classList.remove("active"));
    inp.classList.add("active");
  });
}

export function initDots(ctx: PlanCtx): void {
  const { root, strokes, lineColors, caps, phaseListeners, layerListeners } = ctx;
  const { bindXPhases, zeusBlocked, selectablePhases, samePlanePhases } = ctx.model;

  // ── Panel-Zustand (nur dieses Modul) ──
  const saved = ((): { color?: number; size?: number } => {
    try {
      return JSON.parse(localStorage.getItem(STYLE_KEY) || "{}") || {};
    } catch {
      return {};
    }
  })();
  let dotColor: number =
    typeof saved.color === "number" ? saved.color : (lineColors.find((c) => c.isDefault) ?? lineColors[0]).packedColor;
  let dotSize: number = typeof saved.size === "number" ? nearestSize(saved.size) : DOT_DEFAULT_SIZE;
  let dotPhaseId: string | null = ctx.currentPhaseId || null;
  let dotExtra: string[] = [];
  let dotLayerId: string | null = null;
  const persist = () => {
    try {
      localStorage.setItem(STYLE_KEY, JSON.stringify({ color: dotColor, size: dotSize }));
    } catch {
      /* ignore */
    }
  };

  const colorBox = root.querySelector<HTMLDivElement>("#dc")!;
  wireColorBox(colorBox, lineColors, () => dotColor, (c) => {
    dotColor = c;
    persist();
  });
  const sizeSel = root.querySelector<HTMLSelectElement>("#dSize")!;
  sizeSel.innerHTML = sizeOptions(dotSize);
  sizeSel.addEventListener("change", () => {
    dotSize = Number(sizeSel.value) || DOT_DEFAULT_SIZE;
    persist();
  });
  const textIn = root.querySelector<HTMLInputElement>("#dText")!;
  // Enter im Textfeld: zurück zur Karte (nächster Klick setzt den Punkt)
  textIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") textIn.blur();
  });
  const phaseSel = root.querySelector<HTMLSelectElement>("#dPhase")!;
  const layerSel = root.querySelector<HTMLSelectElement>("#dLayer")!;
  const fillPhases = () => {
    phaseSel.innerHTML = selectablePhases()
      .map((ph) => `<option value="${esc(ph.id)}">${ph.plane === "builder" ? "⚑ " : ""}${esc(ph.name)}</option>`)
      .join("");
    phaseSel.value = dotPhaseId ?? "";
  };
  const fillLayers = () => {
    layerSel.innerHTML =
      `<option value="">${t("tac.autoOpt")}</option>` +
      ctx.tacLayers.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("");
    if (dotLayerId && !ctx.tacLayers.some((l) => l.id === dotLayerId)) dotLayerId = null;
    layerSel.value = dotLayerId ?? "";
  };
  fillPhases();
  fillLayers();
  layerListeners.push(fillLayers);
  layerSel.addEventListener("change", () => (dotLayerId = layerSel.value || null));
  const renderX = bindXPhases(root.querySelector<HTMLElement>("#dXph")!, () => dotPhaseId, () => dotExtra, (v) => (dotExtra = v));
  phaseSel.addEventListener("change", () => {
    dotPhaseId = phaseSel.value || ctx.currentPhaseId || null;
    renderX();
  });
  // Beim Öffnen des Werkzeugs / Phasenwechsel: aktuelle Phase vorauswählen
  const syncDotPanel = () => {
    dotPhaseId = ctx.currentPhaseId || null;
    fillPhases();
    renderX();
  };
  phaseListeners.push(syncDotPanel);

  // ── Punkt setzen ──
  const placeDot = (pos: LngLat2) => {
    if (!caps.draw || zeusBlocked()) return;
    ctx.ui.commitStroke({
      kind: DOT_KIND,
      points: [[pos[0], pos[1]]],
      color: dotColor,
      width: dotSize,
      name: textIn.value.trim(),
      phase_id: dotPhaseId ?? ctx.currentPhaseId ?? null,
      extra_phase_ids: [...dotExtra],
      layer_id: dotLayerId,
    });
  };
  ctx.tools.dot = { click: (e) => placeDot([e.lngLat.lng, e.lngLat.lat]) };

  // ── Bestehenden Punkt bearbeiten (Zahnrad am gewählten Punkt) ──
  function openDotSettings(id: string): void {
    const s = strokes.get(id);
    if (!s || !isStrokeDot(s)) return;
    let color = s.color;
    const back = document.createElement("div");
    back.className = "edit-modal area-name-dlg";
    back.innerHTML = `<div class="card" style="width:min(22rem,96vw)">
      <div class="row"><h1 style="flex:1;margin:0">${t("dot.edit")}</h1><button class="icon-btn" data-x title="${t("common.close")}">${icon("x")}</button></div>
      <label class="chk-lbl">${t("line.color")}</label>
      <div class="line-colors" data-dcolors></div>
      <label class="chk-lbl" title="${t("tip.dot.size")}">${t("dot.size")}
        <select data-dsize>${sizeOptions(nearestSize(s.width))}</select></label>
      <label class="chk-lbl" title="${t("tip.dot.text")}">${t("dot.text")}
        <input data-dtext maxlength="128" value="${esc(s.name ?? "")}" placeholder="${t("dot.textPh")}" /></label>
      <label class="chk-lbl" title="${t("tip.draw.phase")}">${t("phase.assign")}
        <select data-sphase>${selectablePhases()
          .map(
            (ph) =>
              `<option value="${esc(ph.id)}" ${ph.id === s.phase_id ? "selected" : ""}>${ph.plane === "builder" ? "⚑ " : ""}${esc(ph.name)}</option>`,
          )
          .join("")}</select></label>
      <label class="chk-lbl" title="${t("tip.draw.extra")}">${t("phase.extra")}<div data-sx>${phaseMultiHtml("data-xphases", samePlanePhases(s.phase_id ?? null), s.extra_phase_ids ?? [], s.phase_id ?? null)}</div></label>
      <label class="chk-lbl" title="${t("tip.draw.layer")}">${t("wiz.layer")}${layerSelectHtml("data-slayer", ctx.tacLayers, s.layer_id ?? null)}</label>
      <div class="row" style="margin-top:.6rem;gap:.4rem">
        <button class="danger" data-del title="${t("dot.delete")}">${icon("trash", 16)}</button>
        <button class="primary" data-save style="flex:1">${t("common.save")}</button>
      </div>
    </div>`;
    document.body.appendChild(back);
    wireColorBox(back.querySelector<HTMLElement>("[data-dcolors]")!, lineColors, () => color, (c) => (color = c));
    const close = () => back.remove();
    back.addEventListener("mousedown", (e) => e.target === back && close());
    back.querySelector("[data-x]")!.addEventListener("click", close);
    back.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
    const sp = back.querySelector<HTMLSelectElement>("[data-sphase]")!;
    sp.addEventListener("change", () => {
      back.querySelector<HTMLElement>("[data-sx]")!.innerHTML = phaseMultiHtml(
        "data-xphases",
        samePlanePhases(sp.value),
        readPhaseMulti(back, "data-xphases"),
        sp.value,
      );
    });
    back.querySelector("[data-del]")!.addEventListener("click", async () => {
      if (!(await confirmDialog(t("dot.confirmDelete"), { danger: true, trash: true }))) return;
      close();
      if (ctx.editStrokeId === id) ctx.ui.setEditStroke(null);
      ctx.ui.deleteStroke(id);
    });
    back.querySelector("[data-save]")!.addEventListener("click", () => {
      ctx.ui.modifyStroke(id, {
        color,
        width: Number(back.querySelector<HTMLSelectElement>("[data-dsize]")!.value) || DOT_DEFAULT_SIZE,
        name: back.querySelector<HTMLInputElement>("[data-dtext]")!.value.trim(),
        phase_id: sp.value || ctx.currentPhaseId || null,
        extra_phase_ids: readPhaseMulti(back, "data-xphases"),
        layer_id: back.querySelector<HTMLSelectElement>("[data-slayer]")?.value || null,
      });
      close();
    });
    back.querySelector<HTMLInputElement>("[data-dtext]")!.focus();
  }

  Object.assign(ctx.ui, { syncDotPanel, placeDot, openDotSettings });
}
