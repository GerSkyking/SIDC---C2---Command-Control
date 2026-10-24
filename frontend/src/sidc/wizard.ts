// Marker-Wizard — QuickMenü-Baum + Katalog-Browser + Konfiguration (Affiliation,
// Echelon, Richtung, Texte, Channel, Lock/Timestamp). Ergebnis = MarkerTemplate,
// das die Plan-Ansicht per Linksklick platziert (wie ATAKmaps placeOnClick).

import { t } from "../i18n";
import { icon } from "../icons";
import { toast } from "../notify";
import {
  findEntry,
  loadAllMarkers,
  loadModifiers,
  loadQuickMenu,
  loadTranslations,
  translate,
  type CatalogCategory,
  type CatalogEntry,
  type ModifierCatalog,
  type QuickMenuButton,
} from "./catalog";
import {
  AFFILIATIONS,
  AMPLIFIERS,
  DIRECTIONS,
  IDENTITY_TO_AFFILIATION,
  withAffiliation,
  withAffiliationAndEchelon,
  withModifiers,
  type SidcModifiers,
} from "./sidc";
import { layerSelectHtml, phaseMultiHtml, readPhaseMulti, type TplCtx } from "./layerui";
import { iconSrc } from "./symbol";

export interface MarkerTemplate {
  sidc: string;
  unit_text: string;
  ai_text: string;
  channel?: string;
  layer_id?: string | null;
  extra_phase_ids?: string[];
  locked: boolean;
  timestamp_visible: boolean;
  rotation_degrees: number;
  is_multipoint: boolean;
  max_line_points: number;
  orbat_node_id?: string | null;
  orbat_strength?: number;
  tint?: string;
}

type Done = (t: MarkerTemplate) => void;

export async function openWizard(
  host: HTMLElement,
  onPick: Done,
  ctx: TplCtx = {},
): Promise<void> {
  const [cats, quick, mods] = await Promise.all([
    loadAllMarkers(),
    loadQuickMenu(),
    loadModifiers(),
    loadTranslations(),
  ]);
  if (!cats) {
    toast(t("wiz.noCatalog"), { kind: "error" });
    return;
  }

  const wrap = document.createElement("div");
  wrap.className = "wiz-backdrop";
  wrap.innerHTML = `
    <div class="wiz">
      <div class="wiz-head">
        <button data-tab="quick" class="active">${t("wiz.quickMenu")}</button>
        <button data-tab="builder">${t("wiz.builder")}</button>
        <span class="grow"></span>
        <button class="icon-btn" data-close title="${t("common.close")}">${icon("x")}</button>
      </div>
      <div class="wiz-body"></div>
      <div class="wiz-config" hidden></div>
    </div>`;
  host.appendChild(wrap);

  const body = wrap.querySelector<HTMLDivElement>(".wiz-body")!;
  const config = wrap.querySelector<HTMLDivElement>(".wiz-config")!;
  const close = () => {
    wrap.remove();
    ctx.onClose?.();
  };
  wrap.querySelector("[data-close]")!.addEventListener("click", close);
  wrap.addEventListener("click", (e) => e.target === wrap && close());

  // Im QuickMenü gewählte Fraktion — der Baukasten übernimmt sie als Vorauswahl.
  let pickedAff: string | null = null;
  const onIdentity = (identity: string) => {
    pickedAff = IDENTITY_TO_AFFILIATION[identity] ?? pickedAff;
  };

  let tab: "quick" | "builder" = "quick";
  wrap.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      tab = b.dataset.tab as "quick" | "builder";
      wrap.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("active", x === b));
      render();
    }),
  );

  // ── Konfig-Panel für einen gewählten Eintrag ────────────────────────────
  function configure(entry: CatalogEntry, identity: string | null, btn?: QuickMenuButton): void {
    let aff = identity ? IDENTITY_TO_AFFILIATION[identity] ?? "1" : "1";
    let echelon = "00";
    let dir = -1;
    const modDefs: Record<string, import("./catalog").ModifierOption[]> | null =
      (mods && entry.subCategory && (mods as ModifierCatalog)[entry.subCategory]) || null;
    let advOpen = false;
    let tint = ""; // eigene Markerfarbe (leer = Standard)
    const modSel: SidcModifiers = {};

    const buildSidc = () => {
      let s =
        echelon !== "00"
          ? withAffiliationAndEchelon(entry.sidc, aff, echelon)
          : withAffiliation(entry.sidc, aff);
      return withModifiers(s, modSel);
    };

    const MOD_LABELS: Record<string, string> = {
      modifier1: t("wiz.modifier1"),
      modifier2: t("wiz.modifier2"),
      modifier3: t("wiz.modifier3"),
      modifier4: t("wiz.modifier4"),
    };
    const MOD_KEY: Record<string, keyof SidcModifiers> = {
      modifier1: "m1",
      modifier2: "m2",
      modifier3: "m3",
      modifier4: "m4",
    };
    const advPanel = () => {
      if (!modDefs) return "";
      const groups = ["modifier1", "modifier2", "modifier3", "modifier4"].filter(
        (g) => (modDefs[g] ?? []).length,
      );
      return `<div class="wiz-adv">
        <div class="wiz-adv-h">${t("wiz.advanced")}</div>
        ${groups
          .map((g) => {
            const key = MOD_KEY[g];
            const cur = modSel[key] ?? 0;
            return `<label>${MOD_LABELS[g]}</label><select data-mod="${key}">
              <option value="0">—</option>
              ${modDefs[g]
                .map((o) => `<option value="${o.code}" ${o.code === cur ? "selected" : ""}>${o.description}</option>`)
                .join("")}
            </select>`;
          })
          .join("")}
      </div>`;
    };

    const draw = () => {
      config.hidden = false;
      config.classList.toggle("adv", advOpen && !!modDefs);
      config.innerHTML = `
       <div class="wiz-cfg-main">
        <div class="wiz-cfg-title">
          <img src="${iconSrc(buildSidc())}" width="34" height="34" data-hide-on-error/>
          <strong>${entry.name}</strong>
        </div>
        <label>${t("wiz.affiliation")}</label>
        <div class="wiz-aff">${AFFILIATIONS.map(
          (a) => `<button data-aff="${a.digit}" class="${a.digit === aff ? "active" : ""}">${a.label}</button>`,
        ).join("")}</div>
        <label>${t("wiz.echelon")}</label><select data-echelon>${AMPLIFIERS.map(
          (m) => `<option value="${m.digits}" ${m.digits === echelon ? "selected" : ""}>${m.label}</option>`,
        ).join("")}</select>
        ${
          btn?.needsDirection !== false
            ? `<label>${t("wiz.direction")}</label><div class="wiz-dir">${DIRECTIONS.map(
                (d) => `<button data-dir="${d.degrees}" class="${d.degrees === dir ? "active" : ""}">${d.label}</button>`,
              ).join("")}</div>`
            : ""
        }
        <label>${t("wiz.unitText")}</label><input data-unit maxlength="60" />
        <label>${t("wiz.aiText")}</label><input data-ai maxlength="120" />
        ${
          ctx.layers
            ? `<label>${t("wiz.layer")}</label>${layerSelectHtml("data-layer", ctx.layers, ctx.layerId)}`
            : ""
        }
        ${
          ctx.phases && ctx.phases.length > 1
            ? `<label>${t("phase.extra")}</label>${phaseMultiHtml("data-xphases", ctx.phases, [], ctx.phaseId)}`
            : ""
        }
        <label>${t("marker.color")}</label>
        <div class="row"><input type="color" data-tint value="${tint || "#000000"}" />
          <button type="button" data-tint-reset>${t("marker.colorReset")}</button></div>
        <div class="wiz-flags">
          <label><input type="checkbox" data-lock ${entry.defaultLocked ? "checked" : ""}/> ${t("wiz.locked")}</label>
          <label><input type="checkbox" data-ts ${entry.defaultTimestampVisible !== false ? "checked" : ""}/> ${t("wiz.timestamp")}</label>
        </div>
        ${modDefs ? `<button class="wiz-adv-toggle">${advOpen ? "▾" : "▸"} ${t("wiz.advanced")}</button>` : ""}
        <button class="primary wiz-place">${t("wiz.place")}</button>
       </div>
       ${advOpen ? advPanel() : ""}`;

      config.querySelectorAll<HTMLButtonElement>("[data-aff]").forEach((b) =>
        b.addEventListener("click", () => {
          aff = b.dataset.aff!;
          draw();
        }),
      );
      config.querySelector<HTMLSelectElement>("[data-echelon]")?.addEventListener("change", (e) => {
        echelon = (e.target as HTMLSelectElement).value;
        draw();
      });
      config.querySelectorAll<HTMLButtonElement>("[data-dir]").forEach((b) =>
        b.addEventListener("click", () => {
          dir = Number(b.dataset.dir);
          draw();
        }),
      );
      config.querySelector(".wiz-adv-toggle")?.addEventListener("click", () => {
        advOpen = !advOpen;
        draw();
      });
      config.querySelectorAll<HTMLSelectElement>("[data-mod]").forEach((sel) =>
        sel.addEventListener("change", () => {
          const k = sel.dataset.mod as keyof SidcModifiers;
          modSel[k] = Number(sel.value) || 0; // 0 setzt die SIDC-Stelle aktiv zurück
          draw();
        }),
      );
      config.querySelector<HTMLInputElement>("[data-tint]")?.addEventListener("input", (e) => {
        tint = (e.target as HTMLInputElement).value; // ohne draw(): Farbwähler bleibt offen
      });
      config.querySelector("[data-tint-reset]")?.addEventListener("click", () => {
        tint = "";
        draw();
      });
      const place = () => {
        const sidc = buildSidc();
        onPick({
          sidc,
          unit_text: config.querySelector<HTMLInputElement>("[data-unit]")!.value,
          ai_text: config.querySelector<HTMLInputElement>("[data-ai]")!.value,
          layer_id: config.querySelector<HTMLSelectElement>("[data-layer]")?.value || null,
          extra_phase_ids: readPhaseMulti(config, "data-xphases"),
          locked: config.querySelector<HTMLInputElement>("[data-lock]")!.checked,
          timestamp_visible: config.querySelector<HTMLInputElement>("[data-ts]")!.checked,
          rotation_degrees: dir,
          tint,
          is_multipoint: !!entry.isMultiPointLine,
          max_line_points: entry.maxLinePoints ?? 0,
        });
        close();
      };
      config.querySelector(".wiz-place")!.addEventListener("click", place);
      // gleicher Button oben neben „Zurück", damit man nicht nach unten scrollen muss
      const qnav = body.querySelector(".wiz-quick");
      qnav?.querySelector(".wiz-place-top")?.remove();
      const top = document.createElement("button");
      top.className = "primary wiz-place-top";
      top.textContent = t("wiz.place");
      top.addEventListener("click", place);
      const bk = qnav?.querySelector(".wiz-back");
      if (bk) bk.after(top);
      else qnav?.prepend(top);
    };
    draw();
  }

  // ── Baum-/Listen-Rendering ─────────────────────────────────────────────
  function render(): void {
    config.hidden = true;
    body.innerHTML = "";

    if (tab === "builder") {
      void import("./builder").then(({ renderMarkerBuilder }) =>
        renderMarkerBuilder(body, {
          templateFields: true,
          ctx,
          defaultAffiliation: pickedAff ?? "3",
          submitLabel: t("wiz.place"),
          onTemplate: (tpl) => {
            onPick(tpl);
            close();
          },
        }),
      );
      return;
    }

    if (!quick) {
      body.innerHTML = `<p class="muted">Kein QuickMenü-Katalog hochgeladen.</p>`;
      return;
    }
    renderQuick(body, quick.categoryRows.flatMap((r) => r.categories), cats!, configure, onIdentity);
  }

  render();
}

function renderQuick(
  host: HTMLElement,
  categories: import("./catalog").QuickMenuCategory[],
  cats: CatalogCategory[],
  configure: (e: CatalogEntry, identity: string | null, btn?: QuickMenuButton) => void,
  onIdentity: (identity: string) => void,
): void {
  const nav = document.createElement("div");
  nav.className = "wiz-quick";
  host.appendChild(nav);

  const isMain = (label: string) => /^\s*main\s*$/i.test(label);

  const renderButtons = (
    rows: import("./catalog").QuickMenuRow[],
    identity: string | null,
    back: () => void,
  ) => {
    // Ebene mit nur einer Gruppe → direkt hineinspringen (Punkt „Main"/leere Zwischenstufen)
    const flat = rows.flatMap((r) => r.buttons);
    if (flat.length === 1 && flat[0].isGroup && flat[0].nestedRows.length) {
      renderButtons(flat[0].nestedRows, identity, back);
      return;
    }
    nav.innerHTML = `<button class="wiz-back">${t("wiz.back")}</button>`;
    nav.querySelector(".wiz-back")!.addEventListener("click", back);
    for (const row of rows) {
      const rEl = document.createElement("div");
      rEl.className = "wiz-row";
      for (const btn of row.buttons) {
        const label = translate(btn.buttonLanguageKey) || btn.markerDescription;
        if (isMain(label) && !(btn.isGroup && btn.nestedRows.length)) continue;
        const b = document.createElement("button");
        b.className = "wiz-qbtn";
        b.textContent = btn.isGroup && btn.nestedRows.length ? "↳ " + label : label; // ↳ = Kategorie, ohne = Marker
        b.addEventListener("click", () => {
          if (btn.isGroup && btn.nestedRows.length) {
            renderButtons(btn.nestedRows, identity, () => renderButtons(rows, identity, back));
          } else {
            const e = findEntry(cats, btn.markerDescription);
            if (e) configure(e, identity, btn);
            else toast(`Nicht im Katalog: ${btn.markerDescription}`, { kind: "warn" });
          }
        });
        rEl.appendChild(b);
      }
      if (rEl.childElementCount) nav.appendChild(rEl);
    }
  };

  const openSubs = (cat: import("./catalog").QuickMenuCategory, back: () => void) => {
    const ident = cat.setsIdentity ? cat.identity : null;
    if (ident) onIdentity(ident);
    const subs = cat.subCategories.filter(
      (s) => !isMain(translate(s.buttonLanguageKey || s.subCategoryName)),
    );
    const eff = subs.length ? subs : cat.subCategories;
    if (eff.length === 1) {
      renderButtons(eff[0].rows, ident, back);
      return;
    }
    nav.innerHTML = `<button class="wiz-back">${t("wiz.back")}</button>`;
    nav.querySelector(".wiz-back")!.addEventListener("click", back);
    for (const sub of eff) {
      const sb = document.createElement("button");
      sb.className = "wiz-qbtn";
      sb.textContent = "↳ " + translate(sub.buttonLanguageKey || sub.subCategoryName);
      sb.addEventListener("click", () => renderButtons(sub.rows, ident, () => openSubs(cat, back)));
      nav.appendChild(sb);
    }
  };

  const top = () => {
    if (categories.length === 1) {
      openSubs(categories[0], top);
      return;
    }
    nav.innerHTML = "";
    for (const cat of categories) {
      const b = document.createElement("button");
      b.className = "wiz-qbtn wiz-qcat";
      b.textContent = "↳ " + translate(cat.buttonLanguageKey || cat.categoryName);
      b.addEventListener("click", () => openSubs(cat, top));
      nav.appendChild(b);
    }
  };
  top();
}
