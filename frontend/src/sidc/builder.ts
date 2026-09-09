// Marker-Baukasten: alles als (durchsuchbare) Dropdowns — Kategorie, Marker,
// Identität, Echelon, Modifikatoren — mit Live-Vorschau und SIDC-Anzeige.
// Alternative zum QuickMenü; auch im ORBAT-Knoten-Editor genutzt.
import { t } from "../i18n";
import {
  loadAllMarkers,
  loadChannels,
  loadModifiers,
  loadTranslations,
  translate,
  channelLabel,
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
  templateFields?: boolean; // Texte/Channel/Richtung/Flags zusätzlich anzeigen
  defaultChannel?: string;  // Vorauswahl im Channel-Dropdown (Sichtbarkeit!)
  submitLabel?: string;
  onSidc?: (sidc: string) => void;
  onTemplate?: (tpl: MarkerTemplate) => void;
}

export async function renderMarkerBuilder(host: HTMLElement, opts: BuilderOpts): Promise<void> {
  const [cats, mods, channels] = await Promise.all([
    loadAllMarkers(),
    loadModifiers(),
    opts.templateFields ? loadChannels() : Promise.resolve(null),
    loadTranslations(),
  ]);
  if (!cats) {
    host.innerHTML = `<p class="muted">${t("wiz.noCatalog")}</p>`;
    return;
  }

  // Zustand
  let entry: CatalogEntry | null = null;
  let aff = "1";
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
               <label>${t("wiz.channel")}</label>
               <select data-channel>${(channels?.channels ?? [])
                 .map((c) => `<option value="${c.name}" ${c.name === opts.defaultChannel ? "selected" : ""}>${channelLabel(c)}</option>`)
                 .join("")}</select>
               <div class="mkb-flags">
                 <label><input type="checkbox" data-lock/> ${t("wiz.locked")}</label>
                 <label><input type="checkbox" data-ts checked/> ${t("wiz.timestamp")}</label>
               </div>`
            : ""
        }
      </div>
      <div class="mkb-preview">
        <img data-prev width="72" height="72" onerror="this.style.visibility='hidden'"/>
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

  host.querySelector("[data-submit]")!.addEventListener("click", () => {
    const sidc = buildSidc();
    if (!sidc) return;
    if (opts.onTemplate) {
      const q = <T extends HTMLElement>(s: string) => host.querySelector<T>(s);
      opts.onTemplate({
        sidc,
        unit_text: q<HTMLInputElement>("[data-unit]")?.value ?? "",
        ai_text: q<HTMLInputElement>("[data-ai]")?.value ?? "",
        channel: q<HTMLSelectElement>("[data-channel]")?.value ?? "",
        locked: q<HTMLInputElement>("[data-lock]")?.checked ?? false,
        timestamp_visible: q<HTMLInputElement>("[data-ts]")?.checked ?? true,
        rotation_degrees: Number(q<HTMLSelectElement>("[data-dir]")?.value ?? -1),
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
