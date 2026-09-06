// Marker-Wizard — QuickMenü-Baum + Katalog-Browser + Konfiguration (Affiliation,
// Echelon, Richtung, Texte, Channel, Lock/Timestamp). Ergebnis = MarkerTemplate,
// das die Plan-Ansicht per Linksklick platziert (wie ATAKmaps placeOnClick).

import { t } from "../i18n";
import {
  channelLabel,
  findEntry,
  loadAllMarkers,
  loadChannels,
  loadQuickMenu,
  type CatalogCategory,
  type CatalogEntry,
  type QuickMenuButton,
} from "./catalog";
import {
  AFFILIATIONS,
  AMPLIFIERS,
  DIRECTIONS,
  IDENTITY_TO_AFFILIATION,
  iconUrl,
  withAffiliation,
  withAffiliationAndEchelon,
} from "./sidc";

export interface MarkerTemplate {
  sidc: string;
  unit_text: string;
  ai_text: string;
  channel: string;
  locked: boolean;
  timestamp_visible: boolean;
  rotation_degrees: number;
  is_multipoint: boolean;
  max_line_points: number;
}

type Done = (t: MarkerTemplate) => void;

export async function openWizard(host: HTMLElement, onPick: Done): Promise<void> {
  const [cats, quick, channels] = await Promise.all([
    loadAllMarkers(),
    loadQuickMenu(),
    loadChannels(),
  ]);
  if (!cats) {
    alert(t("wiz.noCatalog"));
    return;
  }

  const wrap = document.createElement("div");
  wrap.className = "wiz-backdrop";
  wrap.innerHTML = `
    <div class="wiz">
      <div class="wiz-head">
        <button data-tab="quick" class="active">${t("wiz.quickMenu")}</button>
        <button data-tab="cat">${t("wiz.catalog")}</button>
        <input class="wiz-search" placeholder="${t('wiz.search')}" />
        <span class="grow"></span>
        <button data-close>✕</button>
      </div>
      <div class="wiz-body"></div>
      <div class="wiz-config" hidden></div>
    </div>`;
  host.appendChild(wrap);

  const body = wrap.querySelector<HTMLDivElement>(".wiz-body")!;
  const config = wrap.querySelector<HTMLDivElement>(".wiz-config")!;
  const search = wrap.querySelector<HTMLInputElement>(".wiz-search")!;
  const close = () => wrap.remove();
  wrap.querySelector("[data-close]")!.addEventListener("click", close);
  wrap.addEventListener("click", (e) => e.target === wrap && close());

  let tab: "quick" | "cat" = "quick";
  wrap.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      tab = b.dataset.tab as "quick" | "cat";
      wrap.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("active", x === b));
      render();
    }),
  );
  search.addEventListener("input", render);

  // ── Konfig-Panel für einen gewählten Eintrag ────────────────────────────
  function configure(entry: CatalogEntry, identity: string | null, btn?: QuickMenuButton): void {
    const isLandUnit = entry.languageKey.includes("-LandUnits-");
    let aff = identity ? IDENTITY_TO_AFFILIATION[identity] ?? "1" : "1";
    let echelon = "00";
    let dir = -1;

    const draw = () => {
      config.hidden = false;
      config.innerHTML = `
        <div class="wiz-cfg-title">
          <img src="${iconUrl(
            isLandUnit ? withAffiliationAndEchelon(entry.sidc, aff, echelon) : withAffiliation(entry.sidc, aff),
          )}" width="34" height="34" onerror="this.style.visibility='hidden'"/>
          <strong>${entry.name}</strong>
        </div>
        <label>${t("wiz.affiliation")}</label>
        <div class="wiz-aff">${AFFILIATIONS.map(
          (a) => `<button data-aff="${a.digit}" class="${a.digit === aff ? "active" : ""}">${a.label}</button>`,
        ).join("")}</div>
        ${
          isLandUnit
            ? `<label>${t("wiz.echelon")}</label><select data-echelon>${AMPLIFIERS.map(
                (m) => `<option value="${m.digits}" ${m.digits === echelon ? "selected" : ""}>${m.label}</option>`,
              ).join("")}</select>`
            : ""
        }
        ${
          btn?.needsDirection !== false
            ? `<label>${t("wiz.direction")}</label><div class="wiz-dir">${DIRECTIONS.map(
                (d) => `<button data-dir="${d.degrees}" class="${d.degrees === dir ? "active" : ""}">${d.label}</button>`,
              ).join("")}</div>`
            : ""
        }
        <label>${t("wiz.unitText")}</label><input data-unit maxlength="60" />
        <label>${t("wiz.aiText")}</label><input data-ai maxlength="120" />
        <label>${t("wiz.channel")}</label><select data-channel>${(channels?.channels ?? [])
          .map((c) => `<option value="${c.name}" ${c.name === entry.name ? "" : ""}>${channelLabel(c)}</option>`)
          .join("")}</select>
        <div class="wiz-flags">
          <label><input type="checkbox" data-lock ${entry.defaultLocked ? "checked" : ""}/> ${t("wiz.locked")}</label>
          <label><input type="checkbox" data-ts ${entry.defaultTimestampVisible !== false ? "checked" : ""}/> ${t("wiz.timestamp")}</label>
        </div>
        <button class="primary wiz-place">${t("wiz.place")}</button>`;

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
      config.querySelector(".wiz-place")!.addEventListener("click", () => {
        const sidc = isLandUnit
          ? withAffiliationAndEchelon(entry.sidc, aff, echelon)
          : withAffiliation(entry.sidc, aff);
        onPick({
          sidc,
          unit_text: config.querySelector<HTMLInputElement>("[data-unit]")!.value,
          ai_text: config.querySelector<HTMLInputElement>("[data-ai]")!.value,
          channel: config.querySelector<HTMLSelectElement>("[data-channel]")!.value,
          locked: config.querySelector<HTMLInputElement>("[data-lock]")!.checked,
          timestamp_visible: config.querySelector<HTMLInputElement>("[data-ts]")!.checked,
          rotation_degrees: dir,
          is_multipoint: !!entry.isMultiPointLine,
          max_line_points: entry.maxLinePoints ?? 0,
        });
        close();
      });
    };
    draw();
  }

  // ── Baum-/Listen-Rendering ─────────────────────────────────────────────
  function render(): void {
    const q = search.value.trim().toLowerCase();
    config.hidden = true;
    body.innerHTML = "";

    if (tab === "cat" || q) {
      const list = document.createElement("div");
      list.className = "wiz-list";
      for (const cat of cats!) {
        const hits = cat.entries.filter((e) => !q || e.name.toLowerCase().includes(q));
        if (!hits.length) continue;
        const h = document.createElement("div");
        h.className = "wiz-cat-h";
        h.textContent = cat.label;
        list.appendChild(h);
        for (const e of hits) {
          const row = document.createElement("button");
          row.className = "wiz-entry";
          row.innerHTML = `<img src="${iconUrl(withAffiliation(e.sidc, "1"))}" width="22" height="22" onerror="this.style.visibility='hidden'"/> ${e.name}`;
          row.addEventListener("click", () => configure(e, null));
          list.appendChild(row);
        }
      }
      body.appendChild(list);
      return;
    }

    if (!quick) {
      body.innerHTML = `<p class="muted">Kein QuickMenü-Katalog hochgeladen.</p>`;
      return;
    }
    renderQuick(body, quick.categoryRows.flatMap((r) => r.categories), cats!, configure);
  }

  render();
}

function renderQuick(
  host: HTMLElement,
  categories: import("./catalog").QuickMenuCategory[],
  cats: CatalogCategory[],
  configure: (e: CatalogEntry, identity: string | null, btn?: QuickMenuButton) => void,
): void {
  const nav = document.createElement("div");
  nav.className = "wiz-quick";
  host.appendChild(nav);

  const renderButtons = (
    rows: import("./catalog").QuickMenuRow[],
    identity: string | null,
    back: () => void,
  ) => {
    nav.innerHTML = `<button class="wiz-back">${t("wiz.back")}</button>`;
    nav.querySelector(".wiz-back")!.addEventListener("click", back);
    for (const row of rows) {
      const rEl = document.createElement("div");
      rEl.className = "wiz-row";
      for (const btn of row.buttons) {
        const b = document.createElement("button");
        b.className = "wiz-qbtn";
        b.textContent = btn.buttonLanguageKey;
        b.addEventListener("click", () => {
          if (btn.isGroup && btn.nestedRows.length) {
            renderButtons(btn.nestedRows, identity, () => renderButtons(rows, identity, back));
          } else {
            const e = findEntry(cats, btn.markerDescription);
            if (e) configure(e, identity, btn);
            else alert(`Nicht im Katalog: ${btn.markerDescription}`);
          }
        });
        rEl.appendChild(b);
      }
      nav.appendChild(rEl);
    }
  };

  const top = () => {
    nav.innerHTML = "";
    for (const cat of categories) {
      const b = document.createElement("button");
      b.className = "wiz-qbtn wiz-qcat";
      b.textContent = cat.buttonLanguageKey || cat.categoryName;
      b.addEventListener("click", () => {
        const subNav = () => {
          nav.innerHTML = `<button class="wiz-back">${t("wiz.back")}</button>`;
          nav.querySelector(".wiz-back")!.addEventListener("click", top);
          for (const sub of cat.subCategories) {
            const sb = document.createElement("button");
            sb.className = "wiz-qbtn";
            sb.textContent = sub.buttonLanguageKey || sub.subCategoryName;
            sb.addEventListener("click", () =>
              renderButtons(sub.rows, cat.setsIdentity ? cat.identity : null, subNav),
            );
            nav.appendChild(sb);
          }
        };
        subNav();
      });
      nav.appendChild(b);
    }
  };
  top();
}
