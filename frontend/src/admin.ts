// Admin-Bereich, kategorisiert: Benutzer & Gruppen / Log / Config (Karten + Kataloge).
import { api, ApiError, type AdminGroup, type AdminUser } from "./api";
import { configHtml, wireConfig } from "./adminConfig";
import { langSelect, t, wireLangSelect } from "./i18n";
import { icon } from "./icons";
import { sidebar, themeSwitch, wireSidebar, wireThemeSwitch, type NavSection } from "./ui";

export type AdminSection = "users" | "log" | "config";

export async function renderAdmin(app: HTMLElement, section: AdminSection = "users"): Promise<void> {
  const me = await api.me().catch(() => null);
  const shell = (body: string, title: string) => `
   <div class="shell">
    ${sidebar(section as NavSection, { isAdmin: true, username: me?.username ?? "", isMissionBuilder: !!me?.is_mission_builder_effective })}
    <div class="shell-main">
    <div class="topbar"><strong>${title}</strong><span class="grow"></span>${themeSwitch()}${langSelect()}</div>
    <div class="list stack">${body}</div>
    </div>
   </div>`;

  const reload = () => renderAdmin(app, section);
  const guard = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      reload();
    } catch (e) {
      alert(e instanceof ApiError ? e.message : t("common.error"));
    }
  };

  if (section === "config") {
    const [maps, sources, catStatus] = await Promise.all([
      api.maps().catch(() => []),
      api.mapSources().catch(() => []),
      api.catalogStatus().catch(() => ({}) as Record<string, boolean>),
    ]);
    app.innerHTML = shell(configHtml(maps, sources, catStatus), t("admin.config"));
    postShell(app);
    wireConfig(app.querySelector<HTMLElement>(".list")!, reload);
    return;
  }

  if (section === "log") {
    app.innerHTML = shell(
      `<h2>${t("admin.log")}</h2>
       <div class="row">
         <input id="lg-action" placeholder="action (login, plan, map, …)" />
         <input id="lg-user" placeholder="${t("auth.username")}" />
         <button id="lg-load">${t("admin.logFilter")}</button>
         <button id="lg-more">${t("admin.logMore")}</button>
       </div>
       <div id="lg-out"><table class="acl-tbl"><tbody></tbody></table></div>`,
      t("admin.log"),
    );
    postShell(app);
    let logOffset = 0;
    const loadLog = async (reset: boolean, count = 30) => {
      if (reset) logOffset = 0;
      const r = await api.adminAudit({
        limit: count,
        offset: logOffset,
        action: (app.querySelector("#lg-action") as HTMLInputElement).value.trim(),
        user: (app.querySelector("#lg-user") as HTMLInputElement).value.trim(),
      });
      const tb = app.querySelector("#lg-out tbody")!;
      if (reset) tb.innerHTML = "";
      tb.insertAdjacentHTML(
        "beforeend",
        r.items
          .map(
            (x) => `<tr>
              <td style="text-align:left">${new Date(x.ts).toLocaleString()}</td>
              <td>${x.user}</td><td><code>${x.action}</code></td><td>${x.target}</td>
              <td style="text-align:left;color:var(--muted)">${Object.entries(x.detail)
                .map(([k, v]) => `${k}=${v}`)
                .join(" ")}</td>
            </tr>`,
          )
          .join(""),
      );
      logOffset += r.items.length;
    };
    app.querySelector("#lg-load")!.addEventListener("click", () => void loadLog(true).catch(() => {}));
    app.querySelector("#lg-more")!.addEventListener("click", () => void loadLog(false).catch(() => {}));
    void loadLog(true, 20);
    return;
  }

  // section === "users"
  const [users, groups] = await Promise.all([api.adminUsers(), api.adminGroups()]);
  app.innerHTML = shell(
    `<h2>${t("admin.users")}</h2>
     <table><tbody>${users.map(userRow).join("")}</tbody></table>
     <div class="row">
       <input id="nu-name" placeholder="${t("auth.username")}" />
       <input id="nu-pw" type="password" placeholder="${t("auth.password")} (min. 12)" />
       <select id="nu-role"><option value="user">user</option><option value="admin">admin</option></select>
       <label><input type="checkbox" id="nu-ccp" /> ${t("admin.canCreatePlans")}</label>
       <label><input type="checkbox" id="nu-mb" /> ${t("admin.missionBuilder")}</label>
       <button class="primary" id="nu-add">${t("common.create")}</button>
     </div>

     <h2>${t("admin.groups")}</h2>
     <p class="muted">${t("admin.groupsHint")}</p>
     <table><tbody>${groups.map((g) => groupRow(g, users)).join("")}</tbody></table>
     <div class="row">
       <input id="ng-name" placeholder="${t("admin.groupName")}" />
       <label><input type="checkbox" id="ng-ccp" /> ${t("admin.canCreatePlans")}</label>
       <label><input type="checkbox" id="ng-mb" /> ${t("admin.missionBuilder")}</label>
       <button class="primary" id="ng-add">${t("common.create")}</button>
     </div>`,
    t("admin.usersGroups"),
  );
  postShell(app);

  app.querySelector("#nu-add")!.addEventListener("click", () =>
    guard(() =>
      api.createUser({
        username: (app.querySelector("#nu-name") as HTMLInputElement).value.trim(),
        password: (app.querySelector("#nu-pw") as HTMLInputElement).value,
        role: (app.querySelector("#nu-role") as HTMLSelectElement).value,
        can_create_plans: (app.querySelector("#nu-ccp") as HTMLInputElement).checked,
        is_mission_builder: (app.querySelector("#nu-mb") as HTMLInputElement).checked,
      }),
    ),
  );
  app.querySelectorAll<HTMLElement>("[data-u]").forEach((el) => {
    const id = el.dataset.u!;
    el.querySelector("[data-toggle-active]")?.addEventListener("click", () =>
      guard(() => api.patchUser(id, { is_active: el.dataset.active !== "true" })),
    );
    el.querySelector("[data-toggle-ccp]")?.addEventListener("click", () =>
      guard(() => api.patchUser(id, { can_create_plans: el.dataset.ccp !== "true" })),
    );
    el.querySelector("[data-toggle-mb]")?.addEventListener("click", () =>
      guard(() => api.patchUser(id, { is_mission_builder: el.dataset.mb !== "true" })),
    );
    el.querySelector("[data-reset]")?.addEventListener("click", () => {
      const pw = prompt(t("admin.newPassword"));
      if (pw) guard(() => api.patchUser(id, { password: pw }));
    });
    el.querySelector("[data-del]")?.addEventListener("click", () => {
      if (confirm(t("admin.confirmDeleteUser"))) guard(() => api.deleteUser(id));
    });
  });

  app.querySelector("#ng-add")!.addEventListener("click", () =>
    guard(() =>
      api.createGroup({
        name: (app.querySelector("#ng-name") as HTMLInputElement).value.trim(),
        can_create_plans: (app.querySelector("#ng-ccp") as HTMLInputElement).checked,
        is_mission_builder: (app.querySelector("#ng-mb") as HTMLInputElement).checked,
      }),
    ),
  );
  app.querySelectorAll<HTMLElement>("[data-g]").forEach((el) => {
    const id = el.dataset.g!;
    el.querySelector("[data-delg]")?.addEventListener("click", () => {
      if (confirm(t("admin.confirmDeleteGroup"))) guard(() => api.deleteGroup(id));
    });
    el.querySelectorAll<HTMLInputElement>("[data-member]").forEach((cb) =>
      cb.addEventListener("change", () => {
        const ids = [...el.querySelectorAll<HTMLInputElement>("[data-member]:checked")].map((x) => x.dataset.member!);
        guard(() => api.setGroupMembers(id, ids));
      }),
    );
  });
}

function postShell(app: HTMLElement): void {
  wireLangSelect(app);
  wireThemeSwitch(app);
  wireSidebar(app);
}

function userRow(u: AdminUser): string {
  return `<tr data-u="${u.id}" data-active="${u.is_active}" data-ccp="${u.can_create_plans}" data-mb="${u.is_mission_builder}">
    <td>${u.username} ${u.is_local ? "" : '<span class="badge">OIDC</span>'}</td>
    <td><span class="badge">${u.role}</span></td>
    <td><button data-toggle-active>${u.is_active ? "aktiv" : "deaktiviert"}</button></td>
    <td><button data-toggle-ccp>Pläne: ${u.can_create_plans ? "ja" : "nein"}</button>
        <button data-toggle-mb>Missionsbau: ${u.is_mission_builder ? "ja" : "nein"}</button></td>
    <td>${u.is_local ? "<button data-reset>PW</button>" : ""} <button class="icon-btn" data-del>${icon("x", 16)}</button></td>
  </tr>`;
}

function groupRow(g: AdminGroup, users: AdminUser[]): string {
  return `<tr data-g="${g.id}">
    <td>${g.name} ${g.can_create_plans ? '<span class="badge">Pläne</span>' : ""} ${g.is_mission_builder ? '<span class="badge">Missionsbau</span>' : ""}</td>
    <td>${users
      .map(
        (u) =>
          `<label style="margin-right:.6rem"><input type="checkbox" data-member="${u.id}" ${
            g.member_ids.includes(u.id) ? "checked" : ""
          }/> ${u.username}</label>`,
      )
      .join("")}</td>
    <td><button class="icon-btn" data-delg>${icon("x", 16)}</button></td>
  </tr>`;
}
