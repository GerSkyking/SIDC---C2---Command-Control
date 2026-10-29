import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { api, ApiError, type Me, type PlanFolder } from "./api";
import { openPlanView } from "./plan";
import { renderAdmin } from "./admin";
import { openAclEditor } from "./acl";
import { renderPlanTree, selectedFolder } from "./planTree";
import { renderPublicView } from "./publicview";
import { langSelect, t, wireLangSelect } from "./i18n";
import { confirmDialog, toastError } from "./notify";
import { initSettings, openSettings } from "./settings";
import { renderLegal } from "./legal";
import { esc } from "./esc";
import { icon } from "./icons";
import { initTheme } from "./theme";
import { sidebar, themeSwitch, wireSidebar, wireThemeSwitch } from "./ui";

initTheme();

// Ersatz für inline-Handler (von der Content-Security-Policy verboten):
//   <img data-hide-on-error>     -> bei Ladefehler ausblenden
//   <img data-hide-on-error="none"> -> display:none statt visibility:hidden
//   <input data-select-on-click> -> Inhalt bei Klick markieren
document.addEventListener(
  "error",
  (e) => {
    const el = e.target as HTMLElement | null;
    if (el instanceof HTMLImageElement && el.dataset.hideOnError !== undefined) {
      if (el.dataset.hideOnError === "none") el.style.display = "none";
      else el.style.visibility = "hidden";
    }
  },
  true,
);
document.addEventListener("click", (e) => {
  const el = e.target as HTMLElement | null;
  if (el instanceof HTMLInputElement && el.dataset.selectOnClick !== undefined) el.select();
});

const app = document.querySelector<HTMLDivElement>("#app")!;

let me: Me | null = null;

async function route(): Promise<void> {
  // #/p/<token> — optionaler ~slug (Linkbezeichnung) dahinter dient nur der Unterscheidung
  const pub = location.hash.match(/^#\/p\/([A-Za-z0-9_-]{10,})(?:~[a-z0-9-]*)?$/i);
  if (pub) return renderPublicView(app, pub[1]);

  // Impressum/Datenschutz müssen ohne Login erreichbar sein.
  if (location.hash === "#/impressum") return renderLegal(app, "imprint");
  if (location.hash === "#/datenschutz") return renderLegal(app, "privacy");

  try {
    me = await api.me();
  } catch {
    me = null;
  }

  if (!me) return renderLogin();
  initSettings(me);

  const planMatch = location.hash.match(/^#\/plans\/([0-9a-f]{32})$/);
  if (planMatch) {
    try {
      return await openPlanView(app, planMatch[1], me);
    } catch (e) {
      app.innerHTML = `<div class="center"><div class="card stack">
        <h1>${t("plan.loadFailed")}</h1>
        <p class="error">${e instanceof Error ? e.message : String(e)}</p>
        <a href="#/">${t("nav.back")}</a></div></div>`;
      console.error(e);
      return;
    }
  }
  if (location.hash === "#/trash") return renderTrash();
  const projMatch = location.hash.match(/^#\/projects(?:\/([0-9a-f]{32})(?:\/([a-z]+))?)?$/);
  if (projMatch) {
    const { renderProjects } = await import("./projects");
    return renderProjects(app, me, projMatch[1], projMatch[2]);
  }
  const orbatMatch = location.hash.match(/^#\/orbat(?:\/([0-9a-f]{32}))?$/);
  if (orbatMatch && me.is_mission_builder_effective) {
    const { renderOrbatLibrary } = await import("./orbat");
    return renderOrbatLibrary(app, me, orbatMatch[1]);
  }

  const adminMatch = location.hash.match(/^#\/admin(?:\/(users|log|config|storage))?$/);
  if (adminMatch && me.role === "admin") {
    return renderAdmin(app, (adminMatch[1] as "users" | "log" | "config" | "storage") || "users");
  }
  return renderPlanList();
}

// ─── Login ────────────────────────────────────────────────────────────────

async function renderLogin(): Promise<void> {
  const { enabled: oidc } = await api.oidcEnabled().catch(() => ({ enabled: false }));
  app.innerHTML = `
    <div class="center"><div class="card stack">
      <div class="row"><h1 style="flex:1">${t("app.title")}</h1>${themeSwitch()}${langSelect()}</div>
      <input id="u" placeholder="${t("auth.username")}" autocomplete="username" />
      <input id="p" type="password" placeholder="${t("auth.password")}" autocomplete="current-password" />
      <button class="primary" id="go">${t("auth.login")}</button>
      ${oidc ? `<a href="/auth/oidc/login">${t("auth.oidc")}</a>` : ""}
      <div class="error" id="err"></div>
      <div class="sb-legal" style="justify-content:center">
        <a href="#/impressum">${t("legal.imprint")}</a>
        <a href="#/datenschutz">${t("legal.privacy")}</a>
      </div>
    </div></div>`;
  wireLangSelect(app);
  wireThemeSwitch(app);

  const err = app.querySelector<HTMLDivElement>("#err")!;
  const submit = async () => {
    err.textContent = "";
    try {
      await api.login(
        app.querySelector<HTMLInputElement>("#u")!.value,
        app.querySelector<HTMLInputElement>("#p")!.value,
      );
      location.hash = "#/";
      route();
    } catch (e) {
      err.textContent = e instanceof ApiError ? e.message : t("auth.error");
    }
  };
  app.querySelector("#go")!.addEventListener("click", submit);
  app.querySelector("#p")!.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") submit();
  });
}

// ─── Plan-Liste ───────────────────────────────────────────────────────────

async function renderPlanList(): Promise<void> {
  const [plans, maps, folders] = await Promise.all([
    api.plans(),
    api.maps().catch(() => []),
    api.folders().catch(() => []),
  ]);
  const canCreate = me!.can_create_plans_effective && maps.some((m) => m.status === "ready");
  const folderById = new Map(folders.map((f) => [f.id, f]));
  const folderPath = (f: PlanFolder): string => {
    const parts = [f.name];
    for (let cur = f.parent_id ? folderById.get(f.parent_id) : undefined, n = 0; cur && n < 20; n++) {
      parts.unshift(cur.name);
      cur = cur.parent_id ? folderById.get(cur.parent_id) : undefined;
    }
    return parts.join(" / ");
  };
  const sel = selectedFolder();
  const folderOpts =
    `<option value="">${t("folder.root")}</option>` +
    folders
      .map((f) => ({ f, path: folderPath(f) }))
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(({ f, path }) => `<option value="${f.id}"${f.id === sel ? " selected" : ""}>${esc(path)}</option>`)
      .join("");

  app.innerHTML = `
   <div class="shell">
    ${sidebar("plans", { isAdmin: me!.role === "admin", username: me!.display_name || me!.username, isMissionBuilder: me!.is_mission_builder_effective })}
    <div class="shell-main">
    <div class="topbar">
      <strong>${t("plans.heading")}</strong>
      <span class="grow"></span>
      ${themeSwitch()}
      ${langSelect()}
      <button class="icon-btn" id="settingsBtn" title="${t("settings.open")}" aria-label="${t("settings.open")}">${icon("settings")}</button>
      <span class="muted">${esc(me!.username)} (${esc(me!.role)})</span>
    </div>
    <div class="list stack">
      ${
        canCreate
          ? `<section class="create-card">
               <h2>${t("plans.createTitle")}</h2>
               <p class="muted">${t("plans.createHint")}</p>
               <div class="create-grid">
                 <div class="field">
                   <label for="pn">${t("plans.nameLabel")}</label>
                   <input id="pn" placeholder="${t("plans.planName")}" autocomplete="off" />
                   <small class="muted">${t("plans.nameHint")}</small>
                 </div>
                 <div class="field">
                   <label for="pm">${t("plans.mapLabel")}</label>
                   <select id="pm"><option value="" selected>${t("plans.mapPh")}</option>${maps
                     .filter((m) => m.status === "ready")
                     .map((m) => `<option value="${m.id}">${esc(m.name)}</option>`)
                     .join("")}</select>
                   <small class="muted">${t("plans.mapHint")}</small>
                 </div>
                 <div class="field">
                   <label for="pf">${t("plans.folderLabel")}</label>
                   <select id="pf">${folderOpts}</select>
                   <small class="muted">${t("plans.folderHint")}</small>
                 </div>
               </div>
               <div class="create-actions">
                 <button class="primary" id="pc" title="${t("plans.createHint2")}">${icon("plus", 14)} ${t("plans.create")}</button>
                 <button id="pcs" title="${t("plans.createAccessHint")}">${t("plans.newWithAccess")}</button>
                 <span class="create-msg" id="cmsg" role="status"></span>
               </div>
             </section>`
          : `<div class="muted">${
              me!.can_create_plans_effective ? t("plans.noMap") : t("plans.noPerm")
            }</div>`
      }
      <h2 class="plans-title">${t("plans.listTitle")}</h2>
      <div class="plan-tree" id="planTree"></div>
    </div>
    </div>
   </div>`;
  wireLangSelect(app);
  wireThemeSwitch(app);
  wireSidebar(app);
  app.querySelector("#settingsBtn")!.addEventListener("click", openSettings);

  renderPlanTree(app.querySelector<HTMLDivElement>("#planTree")!, plans, folders, me!.can_create_plans_effective, {
    user: { id: me!.id, isAdmin: me!.role === "admin" },
    mapName: (id) => maps.find((m) => m.id === id)?.name ?? id,
    onChanged: () => renderPlanList(),
    onSelectFolder: (id) => {
      const pf = app.querySelector<HTMLSelectElement>("#pf");
      if (pf) pf.value = id ?? "";
    },
    onDeletePlan: async (p) => {
      if (await confirmDialog(t("plans.confirmDelete"), { danger: true, trash: true })) {
        await api.deletePlan(p.id);
        renderPlanList();
      }
    },
    onOpenShares: (p) => openAclEditor(p.id, p.name),
  });

  const doCreate = async (withAccess: boolean) => {
    const name = app.querySelector<HTMLInputElement>("#pn")!.value.trim();
    const mapId = app.querySelector<HTMLSelectElement>("#pm")!.value;
    const folderId = app.querySelector<HTMLSelectElement>("#pf")?.value || null;
    if (!name || !mapId) {
      showMissing(true);
      return;
    }
    try {
      const p = await api.createPlan(name, mapId, folderId);
      if (withAccess) {
        openAclEditor(p.id, name, () => {
          location.hash = `#/plans/${p.id}`;
          route();
        });
      } else {
        location.hash = `#/plans/${p.id}`;
        route();
      }
    } catch (e) {
      toastError(e);
    }
  };
  // Erstellen erst möglich, wenn Name + Karte gesetzt sind; Hinweis sagt, was noch fehlt.
  const nameEl = app.querySelector<HTMLInputElement>("#pn");
  const mapEl = app.querySelector<HTMLSelectElement>("#pm");
  const msgEl = app.querySelector<HTMLElement>("#cmsg");
  function showMissing(force = false): void {
    if (!nameEl || !mapEl || !msgEl) return;
    const missing = !nameEl.value.trim() ? t("plans.needName") : !mapEl.value ? t("plans.needMap") : "";
    app.querySelectorAll<HTMLButtonElement>("#pc, #pcs").forEach((b) => b.classList.toggle("is-off", !!missing));
    msgEl.textContent = force || msgEl.dataset.touched ? missing : "";
    nameEl.classList.toggle("invalid", force && !nameEl.value.trim());
    mapEl.classList.toggle("invalid", force && !!nameEl.value.trim() && !mapEl.value);
  }
  nameEl?.addEventListener("input", () => { msgEl!.dataset.touched = "1"; showMissing(); });
  mapEl?.addEventListener("change", () => { msgEl!.dataset.touched = "1"; showMissing(); });
  nameEl?.addEventListener("keydown", (e) => { if (e.key === "Enter") void doCreate(false); });
  showMissing();
  app.querySelector("#pc")?.addEventListener("click", () => doCreate(false));
  app.querySelector("#pcs")?.addEventListener("click", () => doCreate(true));
}

async function renderTrash(): Promise<void> {
  const items = await api.trash().catch(() => []);
  app.innerHTML = `
   <div class="shell">
    ${sidebar("trash", { isAdmin: me!.role === "admin", username: me!.display_name || me!.username, isMissionBuilder: me!.is_mission_builder_effective })}
    <div class="shell-main">
    <div class="topbar"><strong>${t("nav.trash")}</strong><span class="grow"></span>${themeSwitch()}${langSelect()}</div>
    <div class="list stack">
      <p class="muted">${t("trash.hint")}</p>
      ${
        items.length
          ? `<table><tbody>${items
              .map(
                (p) => `<tr data-p="${p.id}">
                  <td>${esc(p.name)}</td>
                  <td><button data-restore>${t("trash.restore")}</button>
                      <button class="danger" data-purge>${t("trash.purge")}</button></td>
                </tr>`,
              )
              .join("")}</tbody></table>`
          : `<div class="muted">${t("trash.empty")}</div>`
      }
    </div>
    </div>
   </div>`;
  wireLangSelect(app);
  wireThemeSwitch(app);
  wireSidebar(app);
  app.querySelectorAll<HTMLElement>("[data-p]").forEach((row) => {
    const id = row.dataset.p!;
    row.querySelector("[data-restore]")!.addEventListener("click", async () => {
      try {
        await api.undeletePlan(id);
        renderTrash();
      } catch (e) {
        toastError(e);
      }
    });
    row.querySelector("[data-purge]")!.addEventListener("click", async () => {
      if (!(await confirmDialog(t("trash.purgeConfirm"), { danger: true, trash: true }))) return;
      try {
        await api.purgePlan(id);
        renderTrash();
      } catch (e) {
        toastError(e);
      }
    });
  });
}
window.addEventListener("hashchange", route);
route();

// iOS ignoriert user-scalable=no: Seiten-Zoom per Pinch/Doppeltipp zusaetzlich unterbinden (Karte zoomt weiterhin selbst)
for (const ev of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(ev, (e) => e.preventDefault());
