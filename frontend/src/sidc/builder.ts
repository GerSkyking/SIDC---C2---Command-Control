// Marker-Baukasten: alles als (durchsuchbare) Dropdowns — Kategorie, Marker,
// Identität, Echelon, Modifikatoren — mit Live-Vorschau und SIDC-Anzeige.
// Alternative zum QuickMenü; auch im ORBAT-Knoten-Editor genutzt.
import { t } from "../i18n";
import {
  loadAllMarkers,
  loadModifiers,
  loadTranslations,
  translate,
  type CatalogEntry,
  type ModifierCatalog,
  type ModifierOption,
} from "./catalog";
import { combobox } from "./combobox";
import {
  AFFILIATIONS,
  AMPLIFIERS,
  DIRECTIONS,
  withAffiliation,
  withAffiliationAndEchelon,
  withModifiers,
  type SidcModifiers,
} from "./sidc";
import { layerSelectHtml, phaseMultiHtml, readPhaseMulti, type TplCtx } from "./layerui";
import { iconSrc } from "./symbol";
import type { MarkerTemplate } from "./wizard";

const MOD_KEY: Record<string, keyof SidcModifiers> = {
  modifier1: "m1", modifier2: "m2", modifier3: "m3", modifier4: "m4",
};

/** SIDC ohne Identität/Status/Echelon/Modifier — zum Wiedererkennen eines Katalog-Eintrags. */
function baseKey(sidc: string): string {
  const s = (sidc || "").padEnd(30, "0").slice(0, 30).split("");
  for (const i of [3, 6, 7, 8, 9, 16, 17, 18, 19]) s[i] = "0";
  return s.join("");
}

export interface BuilderOpts {
  initialSidc?: string;
  templateFields?: boolean; // Texte/Layer/Richtung/Flags zusätzlich anzeigen
  ctx?: TplCtx;             // eigene Layer + Phasen zur Auswahl
  defaultAffiliation?: string; // Vorauswahl Zugehörigkeit (SIDC-Ziffer), Standard BLUFOR
  submitLabel?: string;
  onSidc?: (sidc: string) => void;
  onTemplate?: (tpl: MarkerTemplate) => void;
}

export async function renderMarkerBuilder(host: HTMLElement, opts: BuilderOpts): Promise<void> {
  const [cats, mods] = await Promise.all([
    loadAllMarkers(),
    loadModifiers(),
    loadTranslations(),
  ]);
  if (!cats) {
    host.innerHTML = `<p class="muted">${t("wiz.noCatalog")}</p>`;
    return;
  }

  // Zustand
  let entry: CatalogEntry | null = null;
  let aff = opts.defaultAffiliation ?? "3"; // BLUFOR, sofern nichts gewählt wurde
  let echelon = "00";
  const modSel: SidcModifiers = {};

  // Vorbelegung aus initialSidc
  if (opts.initialSidc) {
    const bk = baseKey(opts.initialSidc);
    for (const c of cats) {
      const hit = c.entries.find((e) => baseKey(e.sidc) === bk);
      if (hit) { entry = hit; break; }
    }
    const s = opts.initialSidc.padEnd(30, "0");
    aff = s[3] || "1";
    echelon = s.slice(8, 10) || "00";
    modSel.m4 = Number(s[6]) || undefined;
    modSel.m3 = Number(s[7]) || undefined;
    modSel.m1 = Number(s.slice(16, 18)) || undefined;
    modSel.m2 = Number(s.slice(18, 20)) || undefined;
  }

  const modDefs = (): Record<string, ModifierOption[]> | null =>
    (entry && mods && entry.subCategory && (mods as ModifierCatalog)[entry.subCategory]) || null;

  const buildSidc = (): string => {
    if (!entry) return opts.initialSidc || "";
    let s =
      echelon !== "00"
        ? withAffiliationAndEchelon(entry.sidc, aff, echelon)
        : withAffiliation(entry.sidc, aff);
    return withModifiers(s, modSel);
  };

  host.innerHTML = `
    <div class="mkb">
      <div class="mkb-fields">
        <label>${t("wiz.sidcInput")}</label>
        <div class="row"><input data-sidcin inputmode="numeric" maxlength="30" placeholder="10032500001101000000" style="flex:1" />
          <button type="button" data-sidcgo>${t("wiz.sidcGo")}</button></div>
        <label>${t("wiz.catalog")}</label><div data-slot="cat"></div>
        <label>${t("marker.heading")}</label><div data-slot="marker"></div>
        <label>${t("wiz.affiliation")}</label>
        <select data-aff>${AFFILIATIONS.map((a) => `<option value="${a.digit}">${a.label}</option>`).join("")}</select>
        <div data-echrow hidden><label>${t("wiz.echelon")}</label>
          <select data-ech>${AMPLIFIERS.map((m) => `<option value="${m.digits}">${m.label}</option>`).join("")}</select>
        </div>
        <div data-modrow></div>
        ${
          opts.templateFields
            ? `<label>${t("wiz.direction")}</label>
               <select data-dir>${DIRECTIONS.map((d) => `<option value="${d.degrees}">${d.label}</option>`).join("")}</select>
               <label>${t("wiz.unitText")}</label><input data-unit maxlength="60" />
               <label>${t("wiz.aiText")}</label><input data-ai maxlength="120" />
               ${
                 opts.ctx?.layers?.length
                   ? `<label>${t("wiz.layer")}</label>${layerSelectHtml("data-layer", opts.ctx.layers, opts.ctx.layerId)}`
                   : ""
               }
               ${
                 opts.ctx?.phases && opts.ctx.phases.length > 1
                   ? `<label>${t("phase.extra")}</label>${phaseMultiHtml("data-xphases", opts.ctx.phases, [], opts.ctx.phaseId)}`
                   : ""
               }
               <label>${t("marker.color")}</label>
               <div class="row"><input type="color" data-tint value="#000000" />
                 <button type="button" data-tint-reset>${t("marker.colorReset")}</button></div>
               <div class="mkb-flags">
                 <label><input type="checkbox" data-lock/> ${t("wiz.locked")}</label>
                 <label><input type="checkbox" data-ts checked/> ${t("wiz.timestamp")}</label>
               </div>`
            : ""
        }
      </div>
      <div class="mkb-preview">
        <img data-prev width="72" height="72" data-hide-on-error/>
        <code data-sidc></code>
        <button class="primary" data-submit>${opts.submitLabel ?? t("common.apply")}</button>
      </div>
    </div>`;

  const affSel = host.querySelector<HTMLSelectElement>("[data-aff]")!;
  const echRow = host.querySelector<HTMLDivElement>("[data-echrow]")!;
  const echSel = host.querySelector<HTMLSelectElement>("[data-ech]")!;
  const modRow = host.querySelector<HTMLDivElement>("[data-modrow]")!;
  const prev = host.querySelector<HTMLImageElement>("[data-prev]")!;
  const sidcOut = host.querySelector<HTMLElement>("[data-sidc]")!;
  affSel.value = aff;
  echSel.value = echelon;

  const refresh = () => {
    const sidc = buildSidc();
    prev.src = sidc ? iconSrc(sidc, 72) : "";
    sidcOut.textContent = sidc;
    echRow.hidden = !entry; // Echelon immer wählbar, sobald ein Marker gewählt ist
    const md = modDefs();
    modRow.innerHTML = md
      ? ["modifier1", "modifier2", "modifier3", "modifier4"]
          .filter((g) => (md[g] ?? []).length)
          .map((g) => {
            const key = MOD_KEY[g];
            const cur = modSel[key] ?? 0;
            return `<label>${t("wiz." + g)}</label><select data-mod="${key}">
              <option value="0">—</option>
              ${md[g].map((o) => `<option value="${o.code}" ${o.code === cur ? "selected" : ""}>${o.description}</option>`).join("")}
            </select>`;
          })
          .join("")
      : "";
    modRow.querySelectorAll<HTMLSelectElement>("[data-mod]").forEach((sel) =>
      sel.addEventListener("change", () => {
        modSel[sel.dataset.mod as keyof SidcModifiers] = Number(sel.value) || 0;
        refresh();
      }),
    );
  };

  // Kategorie- + Marker-Combobox
  const markerBox = combobox([], { placeholder: t("marker.heading") }, (v) => {
    entry = cats.flatMap((c) => c.entries).find((e) => e.sidc + "|" + e.name === v) ?? null;
    refresh();
  });
  let catKey = "";
  const setMarkerItems = () => {
    // ohne Kategorie: über alle Kategorien hinweg durchsuchbar
    const src = catKey
      ? cats.find((c) => c.key === catKey)?.entries ?? []
      : cats.flatMap((c) => c.entries.map((e) => ({ e, cat: c.label })));
    const items = catKey
      ? (src as CatalogEntry[]).map((e) => ({
          value: e.sidc + "|" + e.name,
          label: translate(e.name),
          icon: iconSrc(withAffiliation(e.sidc, aff), 22),
        }))
      : (src as { e: CatalogEntry; cat: string }[]).map(({ e, cat }) => ({
          value: e.sidc + "|" + e.name,
          label: translate(e.name),
          sub: cat,
          icon: iconSrc(withAffiliation(e.sidc, aff), 22),
        }));
    markerBox.setItems(items);
  };
  const catBox = combobox(
    [{ value: "", label: t("wiz.builder.allCats") }, ...cats.map((c) => ({ value: c.key, label: c.label, sub: `${c.entries.length}` }))],
    { placeholder: t("wiz.catalog") },
    (v) => {
      catKey = v;
      setMarkerItems();
      entry = null;
      refresh();
    },
  );
  host.querySelector('[data-slot="cat"]')!.replaceWith(catBox.el);
  host.querySelector('[data-slot="marker"]')!.replaceWith(markerBox.el);

  if (entry) {
    const cat = cats.find((c) => c.entries.includes(entry!));
    if (cat) {
      catKey = cat.key;
      catBox.set(cat.key);
    }
  }
  setMarkerItems();
  if (entry) markerBox.set(entry.sidc + "|" + entry.name);

  affSel.addEventListener("change", () => {
    aff = affSel.value;
    setMarkerItems(); // Icons der Liste an die Fraktion anpassen
    refresh();
  });
  echSel.addEventListener("change", () => { echelon = echSel.value; refresh(); });

  let tint = "";
  host.querySelector<HTMLInputElement>("[data-tint]")?.addEventListener("input", (e) => {
    tint = (e.target as HTMLInputElement).value;
  });
  host.querySelector("[data-tint-reset]")?.addEventListener("click", () => {
    tint = "";
    host.querySelector<HTMLInputElement>("[data-tint]")!.value = "#000000";
  });

  // SIDC-Nummer (ganz oder teilweise) eingeben → nächstpassenden Marker wählen und übernehmen/platzieren.
  // Identität (Stelle 4), Status/HQ/Echelon (7–10) zählen beim Vergleichen nicht; vorhandene Stellen
  // für Identität, Echelon und Modifikatoren werden übernommen.
  const sidcIn = host.querySelector<HTMLInputElement>("[data-sidcin]")!;
  const WILD = new Set([3, 6, 7, 8, 9]);
  const applySidcInput = (): boolean => {
    const q = sidcIn.value.replace(/\D/g, "");
    if (q.length < 4) return false;
    let best: CatalogEntry | null = null;
    let bestN = -1;
    for (const c of cats)
      for (const e of c.entries) {
        const cand = e.sidc.padEnd(20, "0");
        let n = 0;
        while (n < q.length && n < 20 && (WILD.has(n) || q[n] === cand[n])) n++;
        if (n > bestN) {
          best = e;
          bestN = n;
        }
      }
    if (!best) return false;
    entry = best;
    if (q.length > 3) aff = q[3];
    if (q.length >= 10 && AMPLIFIERS.some((m) => m.digits === q.slice(8, 10))) echelon = q.slice(8, 10);
    if (q.length >= 20) {
      modSel.m4 = Number(q[6]) || undefined;
      modSel.m3 = Number(q[7]) || undefined;
      modSel.m1 = Number(q.slice(16, 18)) || undefined;
      modSel.m2 = Number(q.slice(18, 20)) || undefined;
    }
    const cat = cats.find((c) => c.entries.includes(best!));
    catKey = cat?.key ?? "";
    catBox.set(catKey);
    setMarkerItems();
    markerBox.set(best.sidc + "|" + best.name);
    affSel.value = aff;
    echSel.value = echelon;
    refresh();
    return true;
  };
  const sidcGo = () => {
    if (applySidcInput()) host.querySelector<HTMLButtonElement>("[data-submit]")!.click();
    else sidcIn.classList.add("invalid");
  };
  host.querySelector("[data-sidcgo]")!.addEventListener("click", sidcGo);
  sidcIn.addEventListener("input", () => sidcIn.classList.remove("invalid"));
  sidcIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sidcGo();
    }
  });

  host.querySelector("[data-submit]")!.addEventListener("click", () => {
    const sidc = buildSidc();
    if (!sidc) return;
    if (opts.onTemplate) {
      const q = <T extends HTMLElement>(s: string) => host.querySelector<T>(s);
      opts.onTemplate({
        sidc,
        unit_text: q<HTMLInputElement>("[data-unit]")?.value ?? "",
        ai_text: q<HTMLInputElement>("[data-ai]")?.value ?? "",
        layer_id: q<HTMLSelectElement>("[data-layer]")?.value || null,
        extra_phase_ids: readPhaseMulti(host, "data-xphases"),
        locked: q<HTMLInputElement>("[data-lock]")?.checked ?? false,
        timestamp_visible: q<HTMLInputElement>("[data-ts]")?.checked ?? true,
        rotation_degrees: Number(q<HTMLSelectElement>("[data-dir]")?.value ?? -1),
        tint,
        is_multipoint: !!entry?.isMultiPointLine,
        max_line_points: entry?.maxLinePoints ?? 0,
      });
    } else {
      opts.onSidc?.(sidc);
    }
  });

  refresh();
}

/** Baukasten in einem eigenständigen Modal (für den ORBAT-Knoten-Editor). */
export function openMarkerBuilderModal(initialSidc: string, onSidc: (sidc: string) => void): void {
  const back = document.createElement("div");
  back.className = "edit-modal";
  back.innerHTML = `<div class="card" style="width:min(46rem,96vw)"><div data-host></div></div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.addEventListener("mousedown", (e) => e.target === back && close());
  void renderMarkerBuilder(back.querySelector<HTMLElement>("[data-host]")!, {
    initialSidc,
    submitLabel: t("common.apply"),
    onSidc: (s) => {
      onSidc(s);
      close();
    },
  });
}
