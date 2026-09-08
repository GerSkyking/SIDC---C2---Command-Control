// Admin → Config: Karten (Import/Update/Löschen), Gitea-Quellen, SIDC-Kataloge,
// Backend-Neustart. Ein in sich geschlossener Baustein — `reload` rendert die Seite neu.
import { api, ApiError, type MapItem, type MapSource } from "./api";
import { t } from "./i18n";
import { icon } from "./icons";

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
          <input type="file" accept="application/json,.json" data-cat="${c.key}" style="display:none" />
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
  const fail = (e: unknown) => alert(e instanceof ApiError ? e.message : t("common.error"));

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
      if (!confirm(`${t("common.delete")}: ${b.dataset.delmap}?`)) return;
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
      if (!confirm(t("common.delete") + "?")) return;
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
        const files = await api.mapSourceFiles(sid);
        box.innerHTML = files.length
          ? files
              .map((f) => {
                const guessId = f.name.replace(/_mappack.*$/i, "").replace(/[^a-z0-9_-]/gi, "").toLowerCase();
                return `<div class="row src-file">
                  <span class="grow">${f.name} <span class="muted">${(f.size / 1048576).toFixed(0)} MB</span></span>
                  <input data-sf-id="${sid}|${f.name}" value="${guessId}" style="width:8rem" />
                  <input data-sf-name="${sid}|${f.name}" value="${guessId}" style="width:9rem" />
                  <button class="primary" data-sf-imp="${sid}|${f.name}">${t("src.import")}</button>
                </div>`;
              })
              .join("")
          : `<span class="muted">${t("src.noZips")}</span>`;
        box.querySelectorAll<HTMLButtonElement>("[data-sf-imp]").forEach((ib) =>
          ib.addEventListener("click", async () => {
            const [s, file] = ib.dataset.sfImp!.split("|");
            const idEl = box.querySelector<HTMLInputElement>(`[data-sf-id="${ib.dataset.sfImp}"]`)!;
            const nameEl = box.querySelector<HTMLInputElement>(`[data-sf-name="${ib.dataset.sfImp}"]`)!;
            if (!idEl.value.trim() || !nameEl.value.trim()) return;
            try {
              await api.importFromSource(idEl.value.trim(), nameEl.value.trim(), s, file);
              setTimeout(reload, 800);
            } catch (e) {
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
    if (!confirm(t("admin.restartConfirm"))) return;
    try {
      await api.restartBackend();
    } catch {
      /* Verbindung bricht beim Neustart erwartungsgemäß ab */
    }
    setTimeout(() => location.reload(), 6000);
  });
}
