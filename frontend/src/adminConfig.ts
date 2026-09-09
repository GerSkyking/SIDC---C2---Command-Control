// Admin → Config: Karten (Import/Update/Löschen), Gitea-Quellen, SIDC-Kataloge,
// Backend-Neustart. Ein in sich geschlossener Baustein — `reload` rendert die Seite neu.
import { api, ApiError, type MapItem, type MapSource } from "./api";
import { t } from "./i18n";
import { icon } from "./icons";
import { confirmDialog, toastError } from "./notify";

export const CATALOGS: { key: string; label: string; file: string }[] = [
  { key: "all-markers", label: "Alle Marker", file: "SIDC_AllMarkersCatalog.json" },
  { key: "quick-menu", label: "QuickMenü", file: "SIDC_QuickMarkerMenuCatalog.json" },
  { key: "phaseline-style", label: "Phase-Line-Stil", file: "SIDC_PhaseLineStyleCatalog.json" },
  { key: "channels", label: "Channels", file: "SIDC_ChannelSettings.json" },
  { key: "modifiers", label: "Modifikatoren", file: "SIDC_ModifierCatalog.json" },
  { key: "translations", label: "Übersetzungen (#Namen)", file: "SIDC_Translations.json" },
];

export function configHtml(
  maps: MapItem[],
  sources: MapSource[],
  catStatus: Record<string, boolean>,
): string {
  return `
    <div class="row"><h2 style="margin:0">${t("admin.maps")}</h2><span class="grow"></span>
      <button id="restart">${t("admin.restart")}</button></div>
    <table><tbody>
      ${maps
        .map(
          (m) => `<tr>
            <td>${m.name} <span class="muted">${m.id}</span></td>
            <td><span class="badge">${m.status}</span></td>
            <td class="muted">${m.error ?? ""}</td>
            <td>
              <input type="file" accept=".zip" data-upd="${m.id}" style="display:none" />
              <button data-updbtn="${m.id}">${t("admin.update")}</button>
              <button data-reimport="${m.id}">${t("admin.fromLink")}</button>
              <button class="icon-btn" data-delmap="${m.id}" title="${t("common.delete")}">${icon("trash", 16)}</button>
            </td>
          </tr>`,
        )
        .join("")}
    </tbody></table>
    <div class="row">
      <input id="mid" placeholder="${t("admin.mapId")}" />
      <input id="mname" placeholder="${t("admin.displayName")}" />
    </div>
    <div class="row">
      <input id="murl" placeholder="${t("admin.downloadUrl")}" style="flex:1" />
      <button id="mi">${t("admin.viaLink")}</button>
    </div>
    <div class="row">
      <input type="file" id="mfile" accept=".zip,application/zip" style="flex:1" />
      <button id="mu">${t("admin.upload")}</button>
    </div>
    <div id="mprogress" class="muted"></div>

    <h2>${t("src.heading")}</h2>
    <div class="stack">
      ${sources
        .map(
          (s) => `<div class="row src-row" data-src="${s.id}">
            <span class="grow"><strong>${s.name}</strong> <span class="muted">${s.base_url}/${s.repo}${s.has_token ? " 🔑" : ""}</span></span>
            <button data-src-files="${s.id}">${t("src.browse")}</button>
            <button class="icon-btn" data-src-del="${s.id}" title="${t("common.delete")}">${icon("trash", 16)}</button>
          </div>
          <div class="src-files" data-src-files-for="${s.id}"></div>`,
        )
        .join("")}
      <div class="row">
        <input id="src-url" placeholder="${t("src.urlPlaceholder")}" style="flex:1" />
        <input id="src-token" type="password" placeholder="${t("src.token")}" style="width:11rem" />
        <button id="src-add">${t("src.add")}</button>
      </div>
    </div>

    <h2>${t("admin.catalog")}</h2>
    <p class="muted">${t("admin.catalogHint")}</p>
    <table><tbody>${CATALOGS.map(
      (c) => `<tr>
        <td>${c.label} <span class="muted">${c.file}</span></td>
        <td><span class="badge">${catStatus[c.key] ? t("admin.loaded") : t("admin.missing")}</span></td>
        <td>
          <input type="file" accept="${c.key === "translations" ? ".xlsx,application/json,.json" : "application/json,.json"}" data-cat="${c.key}" style="display:none" />
          <button data-catbtn="${c.key}">${catStatus[c.key] ? t("admin.update") : t("admin.upload")}</button>
          ${catStatus[c.key] ? `<button class="icon-btn" data-delcat="${c.key}" title="${t("common.delete")}">${icon("trash", 16)}</button>` : ""}
        </td>
      </tr>`,
    ).join("")}</tbody></table>`;
}

export function wireConfig(root: HTMLElement, reload: () => void): void {
  const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s);
  const mapId = () => q<HTMLInputElement>("#mid")!.value.trim();
  const mapName = () => q<HTMLInputElement>("#mname")!.value.trim();
  const prog = () => q<HTMLDivElement>("#mprogress")!;
  const fail = (e: unknown) => toastError(e);

  q("#mi")?.addEventListener("click", async () => {
    const url = q<HTMLInputElement>("#murl")!.value.trim();
    if (!mapId() || !mapName() || !url) return;
    try {
      await api.importMap(mapId(), mapName(), url);
      setTimeout(reload, 600);
    } catch (e) {
      fail(e);
    }
  });
  q("#mu")?.addEventListener("click", async () => {
    const f = q<HTMLInputElement>("#mfile")!.files?.[0];
    if (!mapId() || !mapName() || !f) return;
    try {
      await api.uploadMapFile(mapId(), mapName(), f, (p) => (prog().textContent = `Upload ${p.toFixed(0)} %`));
      prog().textContent = t("admin.processing");
      setTimeout(reload, 1500);
    } catch (e) {
      prog().textContent = "";
      fail(e);
    }
  });
  root.querySelectorAll<HTMLButtonElement>("[data-reimport]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await api.reimportMap(b.dataset.reimport!);
        setTimeout(reload, 800);
      } catch (e) {
        fail(e);
      }
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-updbtn]").forEach((b) =>
    b.addEventListener("click", () => q<HTMLInputElement>(`[data-upd="${b.dataset.updbtn}"]`)!.click()),
  );
  root.querySelectorAll<HTMLInputElement>("[data-upd]").forEach((inp) =>
    inp.addEventListener("change", async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try {
        await api.uploadMapFile(inp.dataset.upd!, "", f, (p) => (prog().textContent = `Update ${p.toFixed(0)} %`));
        prog().textContent = t("admin.processing");
        setTimeout(reload, 1500);
      } catch (e) {
        prog().textContent = "";
        fail(e);
      }
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-delmap]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!(await confirmDialog(`${t("common.delete")}: ${b.dataset.delmap}?`, { danger: true }))) return;
      try {
        await api.deleteMap(b.dataset.delmap!);
        reload();
      } catch (e) {
        fail(e);
      }
    }),
  );

  // Gitea-Quellen
  q("#src-add")?.addEventListener("click", async () => {
    const url = q<HTMLInputElement>("#src-url")!.value.trim();
    const token = q<HTMLInputElement>("#src-token")!.value.trim();
    if (!url) return;
    try {
      await api.createMapSource(url, "", token);
      reload();
    } catch (e) {
      fail(e);
    }
  });
  root.querySelectorAll<HTMLButtonElement>("[data-src-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!(await confirmDialog(t("common.delete") + "?", { danger: true }))) return;
      await api.deleteMapSource(b.dataset.srcDel!);
      reload();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-src-files]").forEach((b) =>
    b.addEventListener("click", async () => {
      const sid = b.dataset.srcFiles!;
      const box = q<HTMLDivElement>(`[data-src-files-for="${sid}"]`)!;
      box.innerHTML = `<span class="muted">${t("src.loading")}</span>`;
      try {
        const files = await api.mapSourceFiles(sid, true);
        const catOpts = CATALOGS.map((c) => `<option value="${c.key}">${c.label}</option>`).join("");
        box.innerHTML = files.length
          ? files
              .map((f, i) => {
                const isZip = /\.zip$/i.test(f.name);
                const sz = f.size >= 1048576 ? `${(f.size / 1048576).toFixed(1)} MB` : `${(f.size / 1024).toFixed(0)} KB`;
                const guessId = f.name.replace(/_mappack.*$/i, "").replace(/[^a-z0-9_-]/gi, "").toLowerCase();
                const guessCat =
                  /translation/i.test(f.name) ? "translations" :
                  /channel/i.test(f.name) ? "channels" :
                  /modifier/i.test(f.name) ? "modifiers" :
                  /quick/i.test(f.name) ? "quick-menu" :
                  /phaseline|phase.line/i.test(f.name) ? "phaseline-style" :
                  /allmarker|all.marker/i.test(f.name) ? "all-markers" : "";
                return `<div class="row src-file">
                  <span class="grow">${f.name} <span class="muted">${sz}</span></span>
                  ${
                    isZip
                      ? `<input data-sf-id="${i}" value="${guessId}" placeholder="map-id" style="width:8rem" />
                         <input data-sf-name="${i}" value="${guessId}" placeholder="Name" style="width:9rem" />
                         <button class="primary" data-sf-map="${i}" data-path="${f.path}">${t("src.importAsMap")}</button>`
                      : `<select data-sf-cat="${i}">${catOpts.replace(
                          `value="${guessCat}"`,
                          `value="${guessCat}" selected`,
                        )}</select>
                         <button class="primary" data-sf-catimp="${i}" data-path="${f.path}">${t("src.import")}</button>`
                  }
                </div>`;
              })
              .join("")
          : `<span class="muted">${t("src.noFiles")}</span>`;

        box.querySelectorAll<HTMLButtonElement>("[data-sf-map]").forEach((ib) =>
          ib.addEventListener("click", async () => {
            const i = ib.dataset.sfMap!;
            const idEl = box.querySelector<HTMLInputElement>(`[data-sf-id="${i}"]`)!;
            const nameEl = box.querySelector<HTMLInputElement>(`[data-sf-name="${i}"]`)!;
            if (!idEl.value.trim() || !nameEl.value.trim()) return;
            try {
              await api.importFromSource(idEl.value.trim(), nameEl.value.trim(), sid, ib.dataset.path!);
              setTimeout(reload, 800);
            } catch (e) {
              fail(e);
            }
          }),
        );
        box.querySelectorAll<HTMLButtonElement>("[data-sf-catimp]").forEach((ib) =>
          ib.addEventListener("click", async () => {
            const sel = box.querySelector<HTMLSelectElement>(`[data-sf-cat="${ib.dataset.sfCatimp}"]`)!;
            ib.disabled = true;
            try {
              await api.importCatalogFromSource(sid, ib.dataset.path!, sel.value);
              setTimeout(reload, 500);
            } catch (e) {
              ib.disabled = false;
              fail(e);
            }
          }),
        );
      } catch (e) {
        box.innerHTML = `<span class="error">${e instanceof ApiError ? e.message : "Fehler"}</span>`;
      }
    }),
  );

  // SIDC-Kataloge
  root.querySelectorAll<HTMLButtonElement>("[data-catbtn]").forEach((b) =>
    b.addEventListener("click", () => q<HTMLInputElement>(`[data-cat="${b.dataset.catbtn}"]`)!.click()),
  );
  root.querySelectorAll<HTMLInputElement>("[data-cat]").forEach((inp) =>
    inp.addEventListener("change", async () => {
      if (!inp.files?.[0]) return;
      try {
        await api.uploadCatalog(inp.dataset.cat!, inp.files[0]);
        reload();
      } catch (e) {
        fail(e);
      }
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-delcat]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await api.deleteCatalog(b.dataset.delcat!);
        reload();
      } catch (e) {
        fail(e);
      }
    }),
  );

  q("#restart")?.addEventListener("click", async () => {
    if (!(await confirmDialog(t("admin.restartConfirm"), { danger: true }))) return;
    try {
      await api.restartBackend();
    } catch {
      /* Verbindung bricht beim Neustart erwartungsgemäß ab */
    }
    setTimeout(() => location.reload(), 6000);
  });
}
