import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { api, ApiError, type Me } from "./api";
import { openPlanView } from "./plan";
import { renderAdmin } from "./admin";
import { openAclEditor } from "./acl";
import { renderPlanTree } from "./planTree";
import { renderPublicView } from "./publicview";
import { langSelect, t, wireLangSelect } from "./i18n";
import { confirmDialog, toastError } from "./notify";
import { initSettings } from "./settings";
import { esc } from "./esc";
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
  const orbatMatch = location.hash.match(/^#\/orbat(?:\/([0-9a-f]{32}))?$/);
  if (orbatMatch && me.is_mission_builder_effective) {
    const { renderOrbatLibrary } = await import("./orbat");
    return renderOrbatLibrary(app, me, orbatMatch[1]);
  }

  const adminMatch = location.hash.match(/^#\/admin(?:\/(users|log|config|images))?$/);
  if (adminMatch && me.role === "admin") {
    return renderAdmin(app, (adminMatch[1] as "users" | "log" | "config" | "images") || "users");
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
  const folderOpts =
    `<option value="">${t("folder.root")}</option>` +
    [...folders].sort((a, b) => a.name.localeCompare(b.name)).map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join("");

  app.innerHTML = `
   <div class="shell">
    ${sidebar("plans", { isAdmin: me!.role === "admin", username: me!.display_name || me!.username, isMissionBuilder: me!.is_mission_builder_effective })}
    <div class="shell-main">
    <div class="topbar">
      <strong>${t("plans.heading")}</strong>
      <span class="grow"></span>
      ${themeSwitch()}
      ${langSelect()}
      <span class="muted">${esc(me!.username)} (${esc(me!.role)})</span>
      <button id="logout">${t("auth.logout")}</button>
    </div>
    <div class="list stack">
      ${
        canCreate
          ? `<div class="row">
               <input id="pn" placeholder="${t("plans.planName")}" />
               <select id="pm">${maps
                 .filter((m) => m.status === "ready")
                 .map((m) => `<option value="${m.id}">${esc(m.name)}</option>`)
                 .join("")}</select>
               <select id="pf" title="${t("plans.moveTo")}">${folderOpts}</select>
               <button class="primary" id="pc">${t("plans.new")}</button>
               <button id="pcs" title="${t("plans.newWithAccess")}">${t("plans.newWithAccess")}</button>
             </div>`
          : `<div class="muted">${
              me!.can_create_plans_effective ? t("plans.noMap") : t("plans.noPerm")
            }</div>`
      }
      <div class="plan-tree" id="planTree"></div>
    </div>
    </div>
   </div>`;
  wireLangSelect(app);
  wireThemeSwitch(app);
  wireSidebar(app);

  renderPlanTree(app.querySelector<HTMLDivElement>("#planTree")!, plans, folders, me!.can_create_plans_effective, {
    mapName: (id) => maps.find((m) => m.id === id)?.name ?? id,
    onChanged: () => renderPlanList(),
    onDeletePlan: async (p) => {
      if (await confirmDialog(t("plans.confirmDelete"), { danger: true })) {
        await api.deletePlan(p.id);
        renderPlanList();
      }
    },
    onOpenShares: (p) => openAclEditor(p.id, p.name),
  });

  app.querySelector("#logout")!.addEventListener("click", async () => {
    await api.logout();
    location.hash = "#/";
    route();
  });
  const doCreate = async (withAccess: boolean) => {
    const name = app.querySelector<HTMLInputElement>("#pn")!.value.trim();
    const mapId = app.querySelector<HTMLSelectElement>("#pm")!.value;
    const folderId = app.querySelector<HTMLSelectElement>("#pf")?.value || null;
    if (!name) return;
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
      if (!(await confirmDialog(t("trash.purgeConfirm"), { danger: true }))) return;
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
