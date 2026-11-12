// Benannte Flächen (geschlossene Linien): Eingabefelder Name / SIDC-Symbol / Füllung — gemeinsam für den
// Dialog direkt nach dem Schließen einer Linie und die Linien-Einstellungen (Zahnrad).
// Das Symbol wird mit dem vorhandenen Marker-Wizard gewählt; angezeigt wird es nur, wenn milsymbol es als
// Punktsymbol zeichnen kann (sonst nur der Name).
import { esc } from "../esc";
import { t } from "../i18n";
import { icon } from "../icons";
import { iconSrc } from "../sidc/symbol";
import { openWizard } from "../sidc/wizard";

export interface AreaFields {
  name: string;
  /** Zusatztext (wie im Marker-Baukasten) */
  ai_text: string;
  sidc: string;
  fill: boolean;
}

/** HTML der Flächen-Felder (Name, Symbol, Füllung). */
export function areaFieldsHtml(f: AreaFields): string {
  return (
    `<label class="chk-lbl">${t("areaName.name")}<input data-area-name maxlength="128" value="${esc(f.name)}" placeholder="${t("areaName.namePh")}" /></label>` +
    `<label class="chk-lbl">${t("wiz.aiText")}<input data-area-ai maxlength="128" value="${esc(f.ai_text)}" /></label>` +
    `<label class="chk-lbl">${t("areaName.symbol")}</label>` +
    `<div class="area-sym" data-area-sym></div>` +
    // Rückfall/Profi-Eingabe: SIDC direkt (z. B. ohne hochgeladenen Marker-Katalog)
    `<details class="area-sidc-raw"><summary class="muted" style="font-size:.75rem" title="${t("tip.area.sidcRaw")}">${t("areaName.sidcRaw")}</summary>` +
    `<input data-area-sidc-in maxlength="30" spellcheck="false" aria-label="${t("areaName.sidcRaw")}" placeholder="10031000001211000000" value="${esc(f.sidc)}" /></details>` +
    `<label class="chk" style="margin-top:.4rem" title="${t("tip.area.fill")}"><input type="checkbox" data-area-fill ${f.fill ? "checked" : ""}/> <span>${t("areaName.fill")}</span></label>`
  );
}

/**
 * Flächen-Felder verdrahten. ``host`` = Dialog-Element, ``hideWhilePicking`` wird ausgeblendet, solange der
 * Marker-Wizard offen ist (der liegt sonst unter dem Dialog). Liefert eine Lese-Funktion.
 */
export function wireAreaFields(host: HTMLElement, f: AreaFields, wizardHost: HTMLElement, hideWhilePicking: HTMLElement): () => AreaFields {
  let sidc = f.sidc;
  const symBox = host.querySelector<HTMLElement>("[data-area-sym]")!;
  const drawSym = () => {
    symBox.innerHTML =
      (sidc ? `<img src="${esc(iconSrc(sidc, 28))}" alt="" data-hide-on-error />` : "") +
      `<button type="button" data-area-pick>${icon("marker", 14)} ${t(sidc ? "areaName.symbolChange" : "areaName.symbolPick")}</button>` +
      (sidc ? `<button type="button" class="icon-btn" data-area-unsym title="${t("areaName.symbolRemove")}">${icon("x", 14)}</button>` : "") +
      (!sidc ? `<p class="muted area-sym-hint">${t("areaName.symbolHint")}</p>` : "");
    symBox.querySelector("[data-area-pick]")!.addEventListener("click", async () => {
      const restore = () => {
        hideWhilePicking.style.display = "";
        delete hideWhilePicking.dataset.picking;
        host.querySelector<HTMLInputElement>("[data-area-name]")?.focus();
      };
      hideWhilePicking.style.display = "none";
      hideWhilePicking.dataset.picking = "1";
      const before = new Set(wizardHost.querySelectorAll(".wiz-backdrop"));
      await openWizard(
        wizardHost,
        (tpl) => {
          setSidc(tpl.sidc);
          // Texte aus dem Marker-Baukasten übernehmen (Einheitstext → Name, Zusatztext), nur wenn Felder leer sind
          const nm = host.querySelector<HTMLInputElement>("[data-area-name]");
          const ai = host.querySelector<HTMLInputElement>("[data-area-ai]");
          if (nm && !nm.value.trim() && tpl.unit_text) nm.value = tpl.unit_text;
          if (ai && !ai.value.trim() && tpl.ai_text) ai.value = tpl.ai_text;
        },
        { onClose: restore },
      );
      // Kein Katalog o. Ä.: der Wizard hat sich gar nicht geöffnet → Dialog wieder zeigen
      const opened = [...wizardHost.querySelectorAll(".wiz-backdrop")].some((w) => !before.has(w));
      if (!opened && hideWhilePicking.dataset.picking) restore();
    });
    symBox.querySelector("[data-area-unsym]")?.addEventListener("click", () => setSidc(""));
  };
  const rawIn = host.querySelector<HTMLInputElement>("[data-area-sidc-in]");
  const setSidc = (v: string) => {
    sidc = v;
    if (rawIn && rawIn.value !== v) rawIn.value = v;
    drawSym();
  };
  rawIn?.addEventListener("input", () => {
    const v = rawIn.value.trim().toUpperCase();
    // nur gültige Formen übernehmen (wie im Backend): 20/30 Ziffern oder 15 Zeichen 2525C
    if (!v || /^(?:\d{20}|\d{30})$/.test(v) || /^[A-Z0-9*-]{15}$/.test(v)) {
      sidc = v;
      drawSym();
    }
  });
  drawSym();
  return () => ({
    name: (host.querySelector<HTMLInputElement>("[data-area-name]")?.value ?? "").trim(),
    ai_text: (host.querySelector<HTMLInputElement>("[data-area-ai]")?.value ?? "").trim(),
    sidc,
    fill: host.querySelector<HTMLInputElement>("[data-area-fill]")?.checked ?? true,
  });
}

/**
 * Dialog direkt nach dem Schließen einer Linie: Name (optional), Symbol (optional), Füllung.
 * „Übernehmen“ → Felder; „Ohne Namen“, Esc oder Klick daneben → Fläche ohne Name/Symbol (Füllung an).
 */
export function openAreaNameDialog(wizardHost: HTMLElement, sig: AbortSignal, done: (f: AreaFields) => void): void {
  const back = document.createElement("div");
  back.className = "edit-modal area-name-dlg";
  back.innerHTML = `<div class="card" style="width:min(24rem,96vw)">
    <div class="row"><h1 style="flex:1;margin:0">${t("areaName.title")}</h1></div>
    <p class="muted" style="margin:.2rem 0 .3rem;font-size:.8rem">${t("areaName.intro")}</p>
    ${areaFieldsHtml({ name: "", ai_text: "", sidc: "", fill: true })}
    <div class="row" style="margin-top:.6rem">
      <button class="primary" data-area-ok style="flex:1">${t("areaName.apply")}</button>
      <button data-area-skip>${t("areaName.skip")}</button>
    </div>
  </div>`;
  document.body.appendChild(back);
  const read = wireAreaFields(back, { name: "", ai_text: "", sidc: "", fill: true }, wizardHost, back);
  const opened = Date.now();
  let finished = false;
  const ac = new AbortController();
  sig.addEventListener("abort", () => ac.abort(), { once: true });
  const finish = (f: AreaFields) => {
    if (finished) return;
    finished = true;
    ac.abort();
    back.remove();
    done(f);
  };
  const skip = () => finish({ name: "", ai_text: "", sidc: "", fill: true });
  back.querySelector("[data-area-ok]")!.addEventListener("click", () => finish(read()));
  back.querySelector("[data-area-skip]")!.addEventListener("click", skip);
  // Klick daneben = ohne Namen (nicht sofort: der zweite Klick eines Doppelklicks landet sonst hier)
  back.addEventListener("mousedown", (e) => {
    if (e.target === back && Date.now() - opened > 500) skip();
  });
  back.querySelector<HTMLInputElement>("[data-area-name]")!.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(read());
    }
  });
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || back.dataset.picking) return; // Esc im Wizard schließt nur den Wizard
      e.preventDefault();
      e.stopPropagation();
      skip();
    },
    { capture: true, signal: ac.signal },
  );
  setTimeout(() => back.querySelector<HTMLInputElement>("[data-area-name]")?.focus(), 0);
}
